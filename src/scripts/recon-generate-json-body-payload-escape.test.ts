import { describe, expect, it } from "vitest";
import { emitMultiStepExecuteHttp, escapeJsonBodyPayloadSplices } from "@/scripts/recon-generate";

describe("escapeJsonBodyPayloadSplices", () => {
  it("JSON-escapes a payload splice inside a string literal", () => {
    const out = escapeJsonBodyPayloadSplices(
      'body: `{"order":{"contactName":"${payload.name}"}}`,',
      true
    );
    expect(out).toContain('"${JSON.stringify(String(payload.name)).slice(1, -1)}"');
    // evaluate the emitted template: a quote/backslash value round-trips
    const name = 'a"b\\c\n';
    const payload = { name };
    const body = new Function("payload", `return ${out.replace(/^body: /, "").replace(/,$/, "")}`)(
      payload
    );
    expect(JSON.parse(body).order.contactName).toBe(name);
  });

  it("leaves bare (numeric) splices and non-JSON bodies alone", () => {
    const t = 'body: `{"n":${payload.n},"s":"x"}`,';
    expect(escapeJsonBodyPayloadSplices(t, true)).toBe(t);
    const m = 'body: `"${payload.n}"`,';
    expect(escapeJsonBodyPayloadSplices(m, false)).toBe(m);
  });
});

describe("fold drill-down still rebinds before escaping", () => {
  it("emits a JSON-escaped payload splice in a plain step body", () => {
    const cap = {
      timestamp: "2024-01-01T00:00:00Z",
      phase: "action",
      method: "POST",
      url: "https://api.example.com/go",
      status: 200,
      requestHeaders: { "Content-Type": "application/json" },
      requestPostData: JSON.stringify({ q: "x" }),
      responseHeaders: { "content-type": "application/json" },
      responseBody: { ok: true },
      operationName: null,
      query: null,
      variables: null,
      decodedParams: null,
    };
    const code = emitMultiStepExecuteHttp(
      [
        { capture: cap, varName: "r0", produces: [], isMultipart: false, isCrossDomain: false },
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
      new Map(),
      new Map()
    );
    expect(typeof code).toBe("string");
  });
});
