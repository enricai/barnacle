/**
 * Single shared definition of "this capture matches the flow's
 * submitEndpointPattern (and submitBodyPattern when declared)". Used by both
 * the submit manifest and the end-of-run audit so they cannot disagree.
 * Method-agnostic: callers decide how to treat GET vs non-GET. Only http(s)
 * requests can be a submission, so a `data:`/`blob:` URL that merely contains
 * the pattern text never matches.
 */
import { isHttpUrl } from "@/recon/capture-filters";

export interface SubmitMatchCapture {
  url?: unknown;
  requestPostData?: unknown;
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
