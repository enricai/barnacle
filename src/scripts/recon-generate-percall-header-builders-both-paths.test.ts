import { describe, expect, it } from "vitest";
import { emitMultiStepExecuteHttp } from "@/scripts/recon-generate";

function step(
  varName: string,
  url: string,
  requestHeaders: Record<string, string>,
  isMultipart: boolean
) {
  return {
    capture: {
      timestamp: "2024-01-01T00:00:00Z",
      phase: "action",
      method: "POST",
      url,
      status: 200,
      requestHeaders,
      requestPostData: isMultipart ? null : JSON.stringify({ a: 1 }),
      responseHeaders: { "content-type": "application/json" },
      responseBody: { ok: true },
      operationName: null,
      query: null,
      variables: null,
      decodedParams: null,
    },
    varName,
    produces: [],
    isMultipart,
    isCrossDomain: false,
  };
}

function emit(isMultipart: boolean, headers: Record<string, string>) {
  return emitMultiStepExecuteHttp(
    [
      step("r0", "https://api.example.com/login/", { "Content-Type": "application/json" }, false),
      step("r1", "https://api.example.com/go", headers, isMultipart),
    ] as never,
    {},
    { stringMessageKey: null, nestedErrorPaths: [] },
    new Map(),
    new Set(),
    new Map(),
    new Set(),
    new Map(),
    new Map(),
    "https://api.example.com",
    new Map([["Origin", "https://api.example.com"]]),
    new Map([["API-ShortName", "acme"]])
  );
}

const HEADERS = {
  "Content-Type": isMultipartCT(),
  Cookie: "sid=abc",
  "X-Correlation-Id": "3f9e2b1a-6d4c-4a7e-9c2f-1a2b3c4d5e6f",
  "Api-Token": "tok-literal-value-123456",
  "X-Auth-Key": "secretkeyvalue1234567890",
  "API-ShortName": "acme",
  Origin: "https://api.example.com",
};

function isMultipartCT() {
  return "application/json";
}

describe.each([
  ["non-multipart", false],
  ["multipart", true],
])("per-call header builder (%s)", (_n, isMultipart) => {
  const body = emit(isMultipart, HEADERS);

  it("never emits Cookie", () => {
    expect(body).not.toContain("sid=abc");
  });
  it("re-mints the correlation id per call", () => {
    expect(body).not.toContain("3f9e2b1a-6d4c-4a7e-9c2f-1a2b3c4d5e6f");
    expect(body).toMatch(/"X-Correlation-Id":\s*`\$\{\w+\}`/);
  });
  it("does not freeze credential literals", () => {
    expect(body).not.toContain("tok-literal-value-123456");
    expect(body).not.toContain("secretkeyvalue1234567890");
  });
  it("emits tenant and baseUrl-derived headers once", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting emitted source
    expect(body).toContain("${payload.");
    const line = body.split("\n").find((l) => l.includes("X-Correlation-Id")) ?? "";
    expect(line.match(/"Origin":/g)?.length).toBe(1);
    expect(line.match(/"API-ShortName":/g)?.length).toBe(1);
  });
});
