/**
 * Indexes the per-request state an HTML response issues: query values in
 * `<form action>` / `<a href>` URLs, path segments of those URLs (a job id or
 * slug a later request re-sends in its own URL), and hidden-input values.
 */

/** Kind of HTML element/location an issued token was read from. */
export type HtmlTokenElement = "form-action" | "link" | "hidden-input" | "path-segment";

export interface HtmlIssuedToken {
  value: string;
  element: HtmlTokenElement;
  /**
   * Query parameter name or input name. For `path-segment` tokens, the URL path
   * with the token's segment replaced by `*` (e.g. `/jobs/*\/candidate`).
   */
  name: string;
}

/** Shortest path segment treated as a producible value. */
export const PATH_SEGMENT_MIN_LENGTH = 6;

/** Entity-decodes the escapes HTML attribute values carry (`&amp;` etc.). */
export function decodeHtmlEntities(v: string): string {
  return v
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

/**
 * A path segment is state-like (an id, hash or slug, not a word such as
 * `jobs`) when it is long, or has a digit or a slug separator.
 */
export function isStateLikeSegment(s: string): boolean {
  if (s.length < PATH_SEGMENT_MIN_LENGTH) return false;
  return s.length >= 16 || /[0-9_-]/.test(s);
}

/**
 * Extracts per-request tokens from an HTML string body. Returns [] for
 * non-string or non-HTML bodies. Values are entity-decoded (`&amp;`).
 */
export function extractHtmlIssuedTokens(body: unknown): HtmlIssuedToken[] {
  if (typeof body !== "string" || !body.includes("<")) return [];
  const out: HtmlIssuedToken[] = [];
  const attr = (tag: string, name: string): string | undefined => {
    const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
    if (!m) return undefined;
    return decodeHtmlEntities(m[1] ?? m[2] ?? m[3] ?? "");
  };
  const safeDecode = (v: string): string => {
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  };
  const fromUrl = (url: string, element: "form-action" | "link"): void => {
    const q = url.indexOf("?");
    if (q >= 0) {
      const query = url.slice(q + 1).split("#")[0] ?? "";
      for (const pair of query.split("&")) {
        const eq = pair.indexOf("=");
        if (eq <= 0) continue;
        out.push({
          value: safeDecode(pair.slice(eq + 1).replace(/\+/g, " ")),
          element,
          name: pair.slice(0, eq),
        });
      }
    }
    const noOrigin = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "");
    const path = noOrigin.split(/[?#]/)[0] ?? "";
    const segs = path.split("/");
    segs.forEach((raw, i) => {
      const value = safeDecode(raw);
      if (!isStateLikeSegment(value)) return;
      const pattern = segs.map((s, k) => (k === i ? "*" : s)).join("/");
      out.push({ value, element: "path-segment", name: pattern });
    });
  };
  for (const m of body.matchAll(/<form\b[^>]*>/gi)) {
    const a = attr(m[0], "action");
    if (a) fromUrl(a, "form-action");
  }
  for (const m of body.matchAll(/<a\b[^>]*>/gi)) {
    const h = attr(m[0], "href");
    if (h) fromUrl(h, "link");
  }
  for (const m of body.matchAll(/<i?frame\b[^>]*>/gi)) {
    const h = attr(m[0], "src");
    if (h) fromUrl(h, "link");
  }
  for (const m of body.matchAll(/<input\b[^>]*>/gi)) {
    if (attr(m[0], "type")?.toLowerCase() !== "hidden") continue;
    const name = attr(m[0], "name");
    const value = attr(m[0], "value");
    if (name && value) out.push({ value, element: "hidden-input", name });
  }
  return out;
}

/**
 * Maps each named `<select>` in an HTML string body to the `value`s of its
 * `<option>`s. Returns an empty map for non-string or non-HTML bodies.
 */
export function extractHtmlSelectOptions(body: unknown): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  if (typeof body !== "string" || !body.includes("<")) return out;
  const attr = (tag: string, name: string): string | undefined => {
    const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
    return m ? decodeHtmlEntities(m[1] ?? m[2] ?? m[3] ?? "") : undefined;
  };
  for (const sel of body.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
    const name = attr(`<select ${sel[1] ?? ""}>`, "name");
    if (!name) continue;
    const values = out.get(name) ?? new Set<string>();
    for (const opt of (sel[2] ?? "").matchAll(/<option\b[^>]*>/gi)) {
      const v = attr(opt[0], "value");
      if (v) values.add(v);
    }
    out.set(name, values);
  }
  return out;
}

export interface HtmlBearerToken {
  token: string;
  claims: Record<string, unknown>;
  source: "rsc-row" | "html";
  /** RSC row id when source is "rsc-row". */
  row?: string;
}

export interface HtmlBearerLocation extends HtmlBearerToken {
  /** Index into the documents array the token was found in. */
  document: number;
}

const JWT_RE = /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

function jwtClaims(token: string): Record<string, unknown> | null {
  try {
    const p = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Concatenate the JS-string-unescaped payloads of `push([1,"..."])` calls. */
function unescapePushPayloads(html: string): string {
  let out = "";
  const re = /push\(\s*\[\s*1\s*,\s*("(?:[^"\\]|\\.)*")\s*\]\s*\)/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    try {
      out += JSON.parse(m[1] as string) as string;
    } catch {
      /* skip malformed payload */
    }
  }
  return out;
}

function tokensIn(
  text: string,
  source: HtmlBearerToken["source"],
  row?: string
): HtmlBearerToken[] {
  const out: HtmlBearerToken[] = [];
  for (const m of text.matchAll(JWT_RE)) {
    const claims = jwtClaims(m[0]);
    if (claims) out.push({ token: m[0], claims, source, ...(row !== undefined ? { row } : {}) });
  }
  return out;
}

/**
 * Find JWT-shaped bearer values in an HTML document. RSC text rows
 * `<id>:T<hex>,<text>` are read at exactly parseInt(hex,16) characters, so a
 * following row id is never absorbed into the token.
 */
export function extractHtmlBearerTokens(body: unknown): HtmlBearerToken[] {
  if (typeof body !== "string") return [];
  const stream = unescapePushPayloads(body);
  const found: HtmlBearerToken[] = [];
  const seen = new Set<string>();
  const add = (list: HtmlBearerToken[]) => {
    for (const t of list) {
      const k = `${t.row ?? ""}|${t.token}`;
      if (!seen.has(k)) {
        seen.add(k);
        found.push(t);
      }
    }
  };
  const rowRe = /([0-9a-zA-Z]+):T([0-9a-fA-F]+),/g;
  for (let m = rowRe.exec(stream); m; m = rowRe.exec(stream)) {
    const start = m.index + m[0].length;
    const len = parseInt(m[2] as string, 16);
    // React counts UTF-8 bytes, not JS characters: walk code points until the byte budget is spent.
    let end = start;
    for (let used = 0; end < stream.length && used < len; ) {
      const cp = stream.codePointAt(end) as number;
      used += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
      end += cp > 0xffff ? 2 : 1;
    }
    add(tokensIn(stream.slice(start, end), "rsc-row", m[1]));
    // Resume right after the row's text; the next row id may follow directly.
    rowRe.lastIndex = end;
  }
  const rscTokens = new Set(found.map((t) => t.token));
  const plain = body.replace(/push\(\s*\[\s*1\s*,\s*"(?:[^"\\]|\\.)*"\s*\]\s*\)/g, "");
  add(tokensIn(plain, "html").filter((t) => !rscTokens.has(t.token)));
  return found;
}

/**
 * Locate a bearer token across documents. `value` matches the exact captured
 * token; `claims` selects by JWT claim values (all must match) rather than
 * position. Returns null when nothing matches.
 */
export function locateHtmlBearerToken(
  documents: ReadonlyArray<unknown>,
  want: { value?: string; claims?: Record<string, unknown> }
): HtmlBearerLocation | null {
  for (let i = 0; i < documents.length; i++) {
    for (const t of extractHtmlBearerTokens(documents[i])) {
      if (want.value !== undefined && t.token !== want.value) continue;
      if (want.claims && !Object.entries(want.claims).every(([k, v]) => t.claims[k] === v))
        continue;
      return { ...t, document: i };
    }
  }
  return null;
}
