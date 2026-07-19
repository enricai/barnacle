/**
 * Site-agnostic fetch scaffold shared by plugins that cannot use
 * `createHttpClient` — typically because they need multipart Buffer bodies
 * or per-response header rotation (per-site token churn). Owns the
 * try/catch network-error conversion, the onResponse hook, and the
 * classifyHttpStatus call so callers only supply the what (URL, headers,
 * body) and the where (their token-rotation / audit hook and context label).
 */

import { fetch as undiciFetch } from "undici";

import { toErrorMessage } from "@/lib/errors";
import { HttpServerError } from "@/scraper/errors";
import { classifyHttpStatus } from "@/scraper/http-status-classifier";

/** Return value: raw outcome before any Zod parsing. */
export interface RawFetchResult {
  status: number;
  rawBody: string;
}

/**
 * Fetch signature this module depends on — the subset of undici's `fetch` that
 * {@link rawFetch} actually uses. Declared structurally so callers can supply a
 * stand-in without importing undici's types.
 */
export type FetchImpl = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: Buffer | string }
) => Promise<{ status: number; headers: Headers; text: () => Promise<string> }>;

/** Input options for {@link rawFetch}. */
export interface RawFetchOptions {
  method: string;
  headers: Record<string, string>;
  /** Optional request body — pass `undefined` for GET requests. */
  body?: Buffer | string;
  /**
   * Overrides the fetch implementation. Defaults to undici's. Exists because
   * this module is consumed from a published package: `undici` is bound here at
   * module load, so a downstream test cannot intercept it by mocking the
   * `undici` specifier from its own module graph — the pre-built engine already
   * holds the real reference. Injecting the double is the supported seam.
   */
  fetchImpl?: FetchImpl;
  /**
   * Called with the response `Headers` on every fetch outcome, including
   * non-2xx. Fires before `classifyHttpStatus` so the caller can harvest
   * rotating session tokens even when the request ultimately fails.
   */
  onResponse: (headers: Headers) => void;
  /**
   * Short label used in error messages from `classifyHttpStatus`, e.g.
   * `"<site> /integrated_questions"`. Should identify the endpoint so
   * logs and error surfaces are actionable.
   */
  contextLabel: string;
  /**
   * When `true`, skip the automatic `classifyHttpStatus` call and return
   * `{ status, rawBody }` for every response. Use when the caller needs
   * to inspect the body before deciding how to classify (e.g. transient-500
   * detection that must precede the generic 5xx path).
   */
  skipClassify?: boolean;
}

/**
 * Issues an undici fetch with caller-supplied URL / method / headers / body,
 * invokes `onResponse` with the response headers (for token rotation or audit),
 * delegates status classification to `classifyHttpStatus`, and returns
 * `{ status, rawBody }` for the caller to parse. Network errors are wrapped
 * in `HttpServerError` so callers get a typed, non-retryable error from the
 * same error hierarchy as classification errors.
 */
export async function rawFetch(url: string, options: RawFetchOptions): Promise<RawFetchResult> {
  const {
    method,
    headers,
    body,
    onResponse,
    contextLabel,
    skipClassify = false,
    fetchImpl = undiciFetch as unknown as FetchImpl,
  } = options;

  let response: Awaited<ReturnType<FetchImpl>>;
  try {
    response = await fetchImpl(url, { method, headers, body });
  } catch (err) {
    throw new HttpServerError(`${contextLabel} network error: ${toErrorMessage(err)}`);
  }

  onResponse(response.headers);

  const rawBody = await response.text();
  if (!skipClassify) {
    classifyHttpStatus(response.status, rawBody.slice(0, 200), contextLabel);
  }

  return { status: response.status, rawBody };
}
