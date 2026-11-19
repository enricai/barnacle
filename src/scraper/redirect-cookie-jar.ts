interface JarCookie {
  name: string;
  value: string;
  /** Lower-case host the cookie applies to. */
  domain: string;
  /** True when no Domain attribute: only the exact origin host matches. */
  hostOnly: boolean;
  path: string;
  secure: boolean;
  /** Epoch ms, or undefined for a session cookie. */
  expires: number | undefined;
}

/** RFC 6265 §5.1.4 default-path. */
function defaultPath(url: URL): string {
  const p = url.pathname;
  if (!p.startsWith("/")) return "/";
  const idx = p.lastIndexOf("/");
  return idx <= 0 ? "/" : p.slice(0, idx);
}

function domainMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

/**
 * Minimal RFC 6265 cookie jar for one redirect chain: records Set-Cookie
 * headers with the host that set them and returns only the cookies a real
 * jar would send to a later URL.
 */
export class RedirectCookieJar {
  private readonly cookies = new Map<string, JarCookie>();

  /** Records one Set-Cookie header received from `origin`. */
  add(setCookie: string, origin: URL, now: number = Date.now()): void {
    const [rawPair, ...attrs] = setCookie.split(";");
    const pair = rawPair ?? "";
    const eq = pair.indexOf("=");
    if (eq === -1) return;
    const name = pair.slice(0, eq).trim();
    if (name === "") return;
    const value = pair.slice(eq + 1).trim();
    const host = origin.hostname.toLowerCase();
    let domain = host;
    let hostOnly = true;
    let path = defaultPath(origin);
    let secure = false;
    let expires: number | undefined;
    let maxAge: number | undefined;
    for (const attr of attrs) {
      const i = attr.indexOf("=");
      const key = (i === -1 ? attr : attr.slice(0, i)).trim().toLowerCase();
      const val = i === -1 ? "" : attr.slice(i + 1).trim();
      if (key === "domain") {
        const d = val.replace(/^\./, "").toLowerCase();
        // A host may only set a Domain that covers itself.
        if (d === "") continue;
        if (!domainMatches(host, d)) return;
        // A bare public suffix (no dot, e.g. "com") would span unrelated sites.
        if (!d.includes(".")) return;
        domain = d;
        hostOnly = false;
      } else if (key === "path") {
        if (val.startsWith("/")) path = val;
      } else if (key === "secure") {
        secure = true;
      } else if (key === "expires") {
        const t = Date.parse(val);
        if (!Number.isNaN(t)) expires = t;
      } else if (key === "max-age") {
        if (/^-?\d+$/.test(val)) maxAge = Number(val);
      }
    }
    if (maxAge !== undefined) expires = maxAge <= 0 ? 0 : now + maxAge * 1000;
    this.cookies.set(`${name}\0${domain}\0${path}`, {
      name,
      value,
      domain,
      hostOnly,
      path,
      secure,
      expires,
    });
  }

  /** Cookies a jar would send to `url`, as name/value pairs. */
  select(url: URL, now: number = Date.now()): Array<[string, string]> {
    const host = url.hostname.toLowerCase();
    const secureTransport = url.protocol === "https:";
    const out: Array<[string, string]> = [];
    for (const c of this.cookies.values()) {
      if (c.expires !== undefined && c.expires <= now) continue;
      if (c.secure && !secureTransport) continue;
      if (c.hostOnly ? host !== c.domain : !domainMatches(host, c.domain)) continue;
      if (!pathMatches(url.pathname || "/", c.path)) continue;
      out.push([c.name, c.value]);
    }
    return out;
  }
}
