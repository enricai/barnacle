/**
 * Single shared definition of "this capture matches the flow's
 * submitEndpointPattern (and submitBodyPattern when declared)". Used by both
 * the submit manifest and the end-of-run audit so they cannot disagree.
 * Method-agnostic: callers decide how to treat GET vs non-GET.
 */
export interface SubmitMatchCapture {
  url?: unknown;
  requestPostData?: unknown;
}

export function matchesSubmitPattern(
  capture: SubmitMatchCapture,
  endpointRx: RegExp,
  bodyRx: RegExp | null
): boolean {
  if (typeof capture.url !== "string") return false;
  if (!endpointRx.test(capture.url)) return false;
  if (bodyRx !== null) {
    const body = typeof capture.requestPostData === "string" ? capture.requestPostData : "";
    if (!bodyRx.test(body)) return false;
  }
  return true;
}
