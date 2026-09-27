import { describe, expect, it } from "vitest";
import {
  compileActionSteps,
  emitMultiStepExecuteHttp,
  indexStateValues,
} from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Pins the per-call header emitter's Cookie-jar handling: a later step's
 * request `Cookie` header is a semicolon-delimited jar of several cookies.
 * One (`itemIdEcho`) coincidentally repeats a value the recon input body
 * itself supplies, the other (`authToken`) is a session-scoped, capture-only
 * value with no corresponding produce at all. Earlier fixes tried to
 * decompose the jar and splice-and-keep only the "recognized" pair — but a
 * substring match on one facet fragment says nothing about the rest of the
 * jar's provenance, so the sanctioned fix is to never emit a captured Cookie
 * header from this per-call loop at all, recognized-looking pair or not; the
 * only legitimate path for a cookie value is the `bind` mechanism.
 */

const LOGIN_URL = "https://api.example.com/catalog/login/";
const SUBMIT_URL = "https://api.example.com/catalog/submit/";

const ITEM_ID_VALUE = "longitemidvalue12345";
const AUTH_TOKEN_COOKIE_VALUE = "zzz.expired.jwt.unrecognized.session.only";

function buildCookieJarCaptures(): ReturnType<typeof buildCapture>[] {
  return [
    buildCapture({
      url: LOGIN_URL,
      requestPostData: JSON.stringify({ itemId: ITEM_ID_VALUE }),
      responseBody: { ok: true },
      timestamp: "2024-09-01T00:00:00Z",
    }),
    // Step 1: sends a jar of two cookies — one echoes the recon input
    // body's own itemId (a real, threadable value), the other is a
    // session-scoped auth token with no known origin at all.
    buildCapture({
      url: SUBMIT_URL,
      requestPostData: JSON.stringify({ itemId: ITEM_ID_VALUE }),
      responseBody: { ok: true },
      requestHeaders: {
        "Content-Type": "application/json",
        Cookie: `authToken=${AUTH_TOKEN_COOKIE_VALUE}; itemIdEcho=${ITEM_ID_VALUE}`,
      },
      timestamp: "2024-09-01T00:00:01Z",
    }),
  ];
}

describe("recon-generate emitMultiStepExecuteHttp — captured multi-cookie Cookie header never freezes verbatim", () => {
  it("never emits the Cookie header at all, not even the pair that looks recognizable via substring match", () => {
    const captures = buildCookieJarCaptures();
    const inputBody = JSON.parse(captures[0]!.requestPostData ?? "null") as unknown;
    const actionCaptures = captures.map((capture, index) => ({ capture, index }));
    const stateIndex = indexStateValues(captures);
    const actionSteps = compileActionSteps(actionCaptures as never, stateIndex);

    const body = emitMultiStepExecuteHttp(
      actionSteps as unknown as Parameters<typeof emitMultiStepExecuteHttp>[0],
      inputBody,
      { stringMessageKey: null, nestedErrorPaths: [] },
      new Map(),
      new Set(),
      new Map(),
      new Set(),
      new Map(),
      new Map(),
      "https://api.example.com",
      new Map(),
      new Map()
    );

    // The raw captured jar must never appear verbatim.
    expect(body).not.toContain(`authToken=${AUTH_TOKEN_COOKIE_VALUE}; itemIdEcho=${ITEM_ID_VALUE}`);
    // The unrecognized, session-scoped auth token never survives as a
    // static literal anywhere in the generated code.
    expect(body).not.toContain(AUTH_TOKEN_COOKIE_VALUE);
    // Nor does the substring-recognizable pair — the whole header is omitted.
    expect(body).not.toContain("itemIdEcho=");
  });
});
