/**
 * Recorded as `Capture.requestPostData` when a request carried a body (CDP
 * `hasPostData: true`) but the body could not be retrieved. Distinguishes
 * "body existed, unavailable" from `null` ("no body"). Dependency-free so
 * recon scripts can import it cheaply.
 */
export const REQUEST_BODY_UNAVAILABLE = "<unavailable>";
