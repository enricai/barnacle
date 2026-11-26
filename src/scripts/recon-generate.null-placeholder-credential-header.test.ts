import { describe, expect, it } from "vitest";
import { emitMultiStepExecuteHttp } from "@/scripts/recon-generate";

const mk = (headers: Record<string, string>, isMultipart: boolean, varName: string) => ({
  capture: {
    timestamp: "2024-01-01T00:00:00Z",
    phase: "action",
    method: "POST",
    url: `https://api.example.com/${varName}`,
    status: 200,
    requestHeaders: headers,
    requestPostData: isMultipart ? "--B\r\nx\r\n--B--" : JSON.stringify({ a: 1 }),
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
});

const emit = (steps: unknown[]) =>
  emitMultiStepExecuteHttp(
    steps as never,
    {},
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

describe("literal null credential header is an empty-token placeholder", () => {
  for (const isMultipart of [false, true]) {
    const label = isMultipart ? "multipart" : "non-multipart";
    const ct = isMultipart ? "multipart/form-data; boundary=B" : "application/json";
    it(`${label}: null is not turned into a throwing credential expression`, () => {
      const out = emit([mk({ "Content-Type": ct, Authorization: " NULL " }, isMultipart, "r0")]);
      expect(out).toContain("` NULL `");
    });
    it(`${label}: a real credential value still takes the credential path`, () => {
      const out = emit([mk({ "Content-Type": ct, Authorization: "Bearer abc.def.ghi" }, isMultipart, "r0")]);
      expect(out).not.toContain("abc.def.ghi");
      expect(out).toMatch(/Authorization/);
    });
  }
});
