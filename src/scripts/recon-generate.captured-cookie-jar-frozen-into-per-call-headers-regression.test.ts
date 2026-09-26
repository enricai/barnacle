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
 * itself supplies — a REAL, genuinely-threadable value — so the pass has
 * something to recognize and thread as `${payload.itemId}`. The other
 * (`authToken`) is a session-scoped, capture-only value with no
 * corresponding produce at all: before this fix, `interpolateStateValues`
 * only ever saw the WHOLE jar as one opaque template, so recognizing ANY
 * one cookie's value inside it froze the entire remaining jar — including
 * the unrecognized `authToken` — verbatim into the per-call literal.
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
  it("threads the recognized cookie pair to its accessor and never lets the unrecognized auth-token-shaped pair ride along frozen in the same literal", () => {
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
    // The genuinely-threadable cookie DOES resolve to its accessor.
    expect(body).toContain("itemIdEcho=$" + "{payload.itemId}");
  });
});
