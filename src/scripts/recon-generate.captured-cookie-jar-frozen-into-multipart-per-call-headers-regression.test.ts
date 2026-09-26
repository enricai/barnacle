import { describe, expect, it } from "vitest";
import { emitMultiStepExecuteHttp } from "@/scripts/recon-generate";

const AUTH_TOKEN_COOKIE_VALUE = "zzz.expired.jwt.unrecognized.session.only";
const ITEM_ID_VALUE = "longitemidvalue12345";

/**
 * Sibling of the non-multipart Cookie-jar regression test: the multipart
 * upload branch of `emitMultiStepExecuteHttp` builds its per-call header
 * overrides through its own loop (it can't share the non-multipart one,
 * since multipart headers merge into `BASE_HEADERS` rather than into
 * `httpClient`'s per-call overrides), so the same jar-decomposition fix
 * must be applied there too or a captured `Cookie` header still freezes
 * verbatim into the emitted multipart request.
 */
const LOGIN_ACTION_STEP = {
  capture: {
    timestamp: "2024-01-01T00:00:00Z",
    phase: "action",
    method: "POST",
    url: "https://api.example.com/catalog/login/",
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ itemId: ITEM_ID_VALUE }),
    responseHeaders: { "content-type": "application/json" },
    responseBody: { ok: true },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  },
  varName: "r0",
  produces: [],
  isMultipart: false,
  isCrossDomain: false,
};

const MULTIPART_UPLOAD_ACTION_STEP = {
  capture: {
    timestamp: "2024-01-01T00:00:01Z",
    phase: "action",
    method: "POST",
    url: "https://api.example.com/upload/files",
    status: 200,
    requestHeaders: {
      "Content-Type": "multipart/form-data",
      Cookie: `authToken=${AUTH_TOKEN_COOKIE_VALUE}; itemIdEcho=${ITEM_ID_VALUE}`,
    },
    requestPostData: null,
    responseHeaders: { "content-type": "application/json" },
    responseBody: { success: true },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  },
  varName: "r1",
  produces: [],
  isMultipart: true,
  isCrossDomain: false,
};

describe("emitMultiStepExecuteHttp — multipart upload never freezes a captured Cookie jar verbatim", () => {
  const body = emitMultiStepExecuteHttp(
    [LOGIN_ACTION_STEP, MULTIPART_UPLOAD_ACTION_STEP] as never,
    { itemId: ITEM_ID_VALUE },
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

  it("never lets the raw captured jar ride along frozen in the multipart headers", () => {
    expect(body).not.toContain(`authToken=${AUTH_TOKEN_COOKIE_VALUE}; itemIdEcho=${ITEM_ID_VALUE}`);
  });

  it("never lets the unrecognized auth-token-shaped pair survive as a static literal", () => {
    expect(body).not.toContain(AUTH_TOKEN_COOKIE_VALUE);
  });

  it("threads the genuinely-threadable cookie to its accessor", () => {
    expect(body).toContain("itemIdEcho=$" + "{payload.itemId}");
  });
});
