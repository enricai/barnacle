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
