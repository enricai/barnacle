import { describe, expect, it } from "vitest";

import { emitContractTs, emitMultiStepExecuteHttp } from "@/scripts/recon-generate";

/** Minimal opts that satisfy the emitter for a non-multipart plugin. */
const BASE_OPTS = {
  siteId: "test-site",
  pascal: "TestSite",
  baseUrl: "https://example.com",
  baseHeaders: { "Content-Type": "application/json" },
  minTime: 100,
  safeRps: 10,
  responseBody: { id: "abc", active: true },
  gql: false,
  gqlQuery: null,
  endpointPath: "/api/search",
  auxFiles: [],
};

describe("emitContractTs — multipart plugin", () => {
  const source = emitContractTs({
    ...BASE_OPTS,
    hasMultipartStep: true,
    inputBody: { Name: "Alice", SmsOptIn: true, Score: 1 },
    multiStepBody: `    return { data: {} as unknown };`,
  });

  it("imports multipartBoolean from @/lib/zod-multipart", () => {
    expect(source).toContain('import { multipartBoolean } from "@/lib/zod-multipart"');
  });

  it("uses multipartBoolean() at boolean payload fields", () => {
    expect(source).toContain("multipartBoolean()");
  });

  it("does not emit an inline MULTIPART_BOOL const declaration", () => {
    expect(source).not.toContain("MULTIPART_BOOL");
    expect(source).not.toContain('z.preprocess(\n  (v) => (v === "true"');
  });
});

describe("emitContractTs — non-multipart plugin", () => {
  const source = emitContractTs({
    ...BASE_OPTS,
    hasMultipartStep: false,
    inputBody: { Name: "Alice", Active: true },
  });

  it("does not import multipartBoolean", () => {
    expect(source).not.toContain("multipartBoolean");
  });

  it("uses z.boolean() for boolean fields", () => {
    expect(source).toContain("z.boolean()");
  });
});

/** Minimal ActionStep with a multipart upload request. */
const MULTIPART_ACTION_STEP = {
  capture: {
    timestamp: "2024-01-01T00:00:00Z",
    phase: "action",
    method: "POST",
    url: "https://api.example.com/upload/files",
    status: 200,
    requestHeaders: { "Content-Type": "multipart/form-data", Accept: "application/json" },
    requestPostData: null,
    responseHeaders: { "content-type": "application/json" },
    responseBody: { success: true },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  },
  varName: "r0",
  produces: [],
  isMultipart: true,
  isCrossDomain: false,
};

describe("emitMultiStepExecuteHttp — multipart upload step", () => {
  const body = emitMultiStepExecuteHttp(
    [MULTIPART_ACTION_STEP],
    null,
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

  it('emits omitHeaderCaseInsensitive(BASE_HEADERS, "Content-Type") for the upload headers', () => {
    expect(body).toContain('omitHeaderCaseInsensitive(BASE_HEADERS, "Content-Type")');
  });

  it("does not emit the inline Object.fromEntries filter idiom", () => {
    expect(body).not.toContain("Object.fromEntries(Object.entries(BASE_HEADERS)");
  });
});

describe("emitContractTs — multipart plugin imports omitHeaderCaseInsensitive", () => {
  const source = emitContractTs({
    ...BASE_OPTS,
    hasMultipartStep: true,
    inputBody: { Name: "Alice", SmsOptIn: true },
    multiStepBody: `    return { data: {} as unknown };`,
  });

  it("imports omitHeaderCaseInsensitive from @/lib/case-insensitive-headers", () => {
    expect(source).toContain(
      'import { omitHeaderCaseInsensitive } from "@/lib/case-insensitive-headers"'
    );
  });
});

describe("emitContractTs — non-multipart plugin does not import omitHeaderCaseInsensitive", () => {
  const source = emitContractTs({
    ...BASE_OPTS,
    hasMultipartStep: false,
    inputBody: { Name: "Alice" },
  });

  it("does not import omitHeaderCaseInsensitive", () => {
    expect(source).not.toContain("omitHeaderCaseInsensitive");
  });
});
