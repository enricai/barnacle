/**
 * Single shared definition of "this capture matches the flow's
 * submitEndpointPattern (and submitBodyPattern when declared)". Used by both
 * the submit manifest and the end-of-run audit so they cannot disagree.
 * Callers decide how to treat GET vs non-GET. Only http(s)
 * requests can be a submission, so a `data:`/`blob:` URL that merely contains
 * the pattern text never matches.
 */
import { isHttpUrl } from "@/recon/capture-filters";
import { isGraphqlQueryDocument } from "@/recon/replay-safety";

export interface SubmitMatchCapture {
  method?: unknown;
  url?: unknown;
  requestPostData?: unknown;
  requestHeaders?: unknown;
}

export function matchesSubmitPattern(
  capture: SubmitMatchCapture,
  endpointRx: RegExp,
  bodyRx: RegExp | null
): boolean {
  if (typeof capture.url !== "string" || !isHttpUrl(capture.url)) return false;
  if (!endpointRx.test(capture.url)) return false;
  if (bodyRx !== null) {
    const body = typeof capture.requestPostData === "string" ? capture.requestPostData : "";
    if (!bodyRx.test(body)) return false;
  }
  return true;
}

/** GraphQL `query` strings carried by a request body (single or batched); null when none. */
function graphqlQueriesOf(body: unknown): string[] | null {
  if (typeof body !== "string" || body === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  if (items.length === 0) return null;
  const out: string[] = [];
  for (const it of items) {
    const q = (it as { query?: unknown } | null)?.query;
    if (typeof q !== "string") return null;
    out.push(q);
  }
  return out;
}

/**
 * Capture-evidence read predicate: a GET/HEAD, or a POST whose body is a
 * GraphQL document made only of query operations. Anything else (a mutation,
 * a non-GraphQL POST, an unparseable body) is not evidence of a read.
 */
export function isReadCapture(capture: SubmitMatchCapture): boolean {
  const method = typeof capture.method === "string" ? capture.method.toUpperCase() : "";
  if (method === "GET" || method === "HEAD") return true;
  if (method !== "POST") return false;
  const queries = graphqlQueriesOf(capture.requestPostData);
  return queries?.every((q) => isGraphqlQueryDocument(q)) === true;
}

/**
 * A page load (browser navigation) of a URL that happens to match the submit
 * pattern is not evidence the flow is read-only: the form page itself loads
 * before any submit fires. Detected from the request's own headers.
 */
export function isDocumentNavigation(capture: SubmitMatchCapture): boolean {
  const h = capture.requestHeaders;
  if (typeof h !== "object" || h === null) return false;
  for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
    const key = k.toLowerCase();
    if (key === "sec-fetch-dest" && typeof v === "string" && /^(document|iframe|frame)$/i.test(v))
      return true;
    if (key === "upgrade-insecure-requests" && String(v) === "1") return true;
  }
  return false;
}

/** True for a 2xx status; a missing or non-numeric status is not a success. */
export function isSuccessStatus(status: unknown): boolean {
  return typeof status === "number" && status >= 200 && status < 300;
}

/**
 * The one qualifying-submit-capture predicate shared by the submit manifest and
 * the end-of-run audit: http(s) URL, matches `endpointRx` (and `bodyRx` when
 * declared), and — when `ownBackendHostnames` is non-empty — the URL hostname
 * is one of them (e.g. `shop.example.com` for `https://shop.example.com/api/orders`).
 * An empty list applies no host gate. `endpointRx === null` skips pattern
 * matching (host gate only). Status policy stays with each caller.
 */
export function isQualifyingSubmitCapture(
  capture: SubmitMatchCapture,
  opts: {
    endpointRx: RegExp | null;
    bodyRx: RegExp | null;
    ownBackendHostnames: readonly string[];
  }
): boolean {
  if (typeof capture.url !== "string") return false;
  // The browser's own CORS preflight shares the submit's URL but submits nothing.
  if (String(capture.method).toUpperCase() === "OPTIONS") return false;
  if (opts.ownBackendHostnames.length > 0) {
    let hostname: string;
    try {
      hostname = new URL(capture.url).hostname;
    } catch {
      return false;
    }
    if (!opts.ownBackendHostnames.includes(hostname)) return false;
  }
  if (opts.endpointRx === null) return true;
  return matchesSubmitPattern(capture, opts.endpointRx, opts.bodyRx);
}
