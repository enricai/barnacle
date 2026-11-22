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
      const query = url.slice(q + 1).split("#")[0]!;
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
    const path = noOrigin.split(/[?#]/)[0]!;
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
  for (const m of body.matchAll(/<input\b[^>]*>/gi)) {
    if (attr(m[0], "type")?.toLowerCase() !== "hidden") continue;
    const name = attr(m[0], "name");
    const value = attr(m[0], "value");
    if (name && value) out.push({ value, element: "hidden-input", name });
  }
  return out;
}
