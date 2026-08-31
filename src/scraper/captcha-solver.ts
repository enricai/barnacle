/**
 * Provider-agnostic captcha-solve client. Site plugins and flow hooks call
 * `solveCaptcha` without knowing which third-party solver backs it; the
 * default (and only) implementation today is 2Captcha, keyed from
 * `TWOCAPTCHA_API_KEY`. Kept generic (no site/plugin naming) so it stays
 * usable by any captcha-gated flow, not just the one that motivated it.
 */

import pRetry, { AbortError } from "p-retry";
import { fetch as undiciFetch } from "undici";

import { config } from "@/config";
import { toErrorMessage } from "@/lib/errors";
import { getLogger } from "@/lib/logging";
import { CaptchaError, CaptchaSolverUnavailableError } from "@/scraper/errors";
import type { FetchImpl } from "@/scraper/raw-fetch";
import { rawFetch } from "@/scraper/raw-fetch";

const logger = getLogger({ name: "scraper/captcha-solver" });

const TWOCAPTCHA_BASE_URL = "https://2captcha.com";
const POLL_INTERVAL_MS = 5000;
const POLL_MAX_ATTEMPTS = 24;

/** Captcha types `solveCaptcha` can be asked to solve. Only invisible hCaptcha is implemented today. */
export type CaptchaType = "hcaptcha";

/** Input to {@link solveCaptcha}. */
export interface SolveCaptchaRequest {
  type: CaptchaType;
  /** The public sitekey read off the target page — never a secret. */
  siteKey: string;
  /** The page the challenge is embedded in, forwarded to the solver as `pageurl`. */
  pageUrl: string;
  /** Whether the widget is an invisible/score-based challenge (`size:invisible`). */
  isInvisible: boolean;
  /**
   * Best-effort UA to bind the solve to, ideally the session's own UA. Not
   * required for every sitekey (2Captcha has accepted mismatched UAs), but
   * forwarding it costs nothing and helps on UA-strict sites.
   */
  userAgent?: string;
  /** Overrides the fetch implementation; defaults to undici's. See raw-fetch.ts's FetchImpl for why this seam exists. */
  fetchImpl?: FetchImpl;
}

/** Result of a successful solve. */
export interface SolveCaptchaResult {
  /** The solved token to inject into the page's response field. */
  token: string;
  /** Which solver produced the token. */
  provider: "2captcha";
  /** Wall-clock milliseconds spent on the create+poll cycle. */
  ms: number;
}

interface TwoCaptchaCreateTaskResponse {
  status: number;
  request: string;
}

interface TwoCaptchaGetResultResponse {
  status: number;
  request: string;
}

async function postForm(
  path: string,
  params: Record<string, string>,
  fetchImpl: FetchImpl,
  contextLabel: string
): Promise<string> {
  const { rawBody } = await rawFetch(`${TWOCAPTCHA_BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
    fetchImpl,
    onResponse: () => {},
    contextLabel,
    skipClassify: true,
  });
  return rawBody;
}

function parseTwoCaptchaResponse(
  raw: string,
  contextLabel: string
): TwoCaptchaCreateTaskResponse | TwoCaptchaGetResultResponse {
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("status" in parsed) ||
    !("request" in parsed)
  ) {
    throw new CaptchaError(`${contextLabel}: unexpected 2Captcha response shape`);
  }
  const { status, request } = parsed as { status: unknown; request: unknown };
  if (typeof status !== "number" || typeof request !== "string") {
    throw new CaptchaError(`${contextLabel}: unexpected 2Captcha response shape`);
  }
  return { status, request };
}

/**
 * Solves a captcha via the configured provider (2Captcha by default) and
 * returns the token to inject into the page. Throws
 * `CaptchaSolverUnavailableError` when no provider key is configured —
 * callers must treat that as a hard failure, never a silent skip, since a
 * missing token means the gated step cannot legitimately advance.
 */
export async function solveCaptcha(request: SolveCaptchaRequest): Promise<SolveCaptchaResult> {
  const apiKey = config.scraper.twoCaptchaApiKey;
  if (!apiKey) {
    throw new CaptchaSolverUnavailableError();
  }

  const {
    type,
    siteKey,
    pageUrl,
    isInvisible,
    userAgent,
    fetchImpl = undiciFetch as unknown as FetchImpl,
  } = request;

  const startedAt = Date.now();
  try {
    const token = await solveViaTwoCaptcha({
      apiKey,
      type,
      siteKey,
      pageUrl,
      isInvisible,
      userAgent,
      fetchImpl,
    });
    const ms = Date.now() - startedAt;
    logger.info(`captcha-solve: provider=2captcha ms=${ms} ok=true`);
    return { token, provider: "2captcha", ms };
  } catch (err) {
    const ms = Date.now() - startedAt;
    logger.error(`captcha-solve: provider=2captcha ms=${ms} ok=false`);
    if (err instanceof CaptchaError) {
      throw err;
    }
    throw new CaptchaError(`2captcha solve failed: ${toErrorMessage(err)}`);
  }
}

interface TwoCaptchaSolveOptions {
  apiKey: string;
  type: CaptchaType;
  siteKey: string;
  pageUrl: string;
  isInvisible: boolean;
  userAgent?: string;
  fetchImpl: FetchImpl;
}

async function solveViaTwoCaptcha(options: TwoCaptchaSolveOptions): Promise<string> {
  const { apiKey, type, siteKey, pageUrl, isInvisible, userAgent, fetchImpl } = options;

  const createParams: Record<string, string> = {
    key: apiKey,
    method: type,
    sitekey: siteKey,
    pageurl: pageUrl,
    invisible: isInvisible ? "1" : "0",
    json: "1",
    ...(userAgent ? { userAgent } : {}),
  };

  const createRaw = await postForm("/in.php", createParams, fetchImpl, "2captcha createTask");
  const created = parseTwoCaptchaResponse(createRaw, "2captcha createTask");
  if (created.status !== 1) {
    throw new CaptchaError(`2captcha createTask rejected: ${created.request}`);
  }
  const taskId = created.request;

  return pRetry(
    async () => {
      const pollRaw = await postForm(
        "/res.php",
        { key: apiKey, action: "get", id: taskId, json: "1" },
        fetchImpl,
        "2captcha getTaskResult"
      );
      const polled = parseTwoCaptchaResponse(pollRaw, "2captcha getTaskResult");
      if (polled.status === 1) {
        return polled.request;
      }
      if (polled.request !== "CAPCHA_NOT_READY") {
        throw new AbortError(new CaptchaError(`2captcha getTaskResult failed: ${polled.request}`));
      }
      throw new CaptchaError("2captcha task not ready yet");
    },
    { retries: POLL_MAX_ATTEMPTS, minTimeout: POLL_INTERVAL_MS, maxTimeout: POLL_INTERVAL_MS }
  );
}
