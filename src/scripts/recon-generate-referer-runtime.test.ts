import { describe, expect, it } from "vitest";
import { emitMultiStepExecuteHttp } from "@/scripts/recon-generate";

const mk = (url: string, referer: string, multipart: boolean, varName: string) => ({
  capture: {
    timestamp: "2024-01-01T00:00:00Z",
    phase: "action",
    method: "POST",
    url,
    status: 200,
    requestHeaders: {
      "Content-Type": multipart ? "multipart/form-data" : "application/json",
      Referer: referer,
    },
    requestPostData: multipart ? null : JSON.stringify({ a: 1 }),
    responseHeaders: { "content-type": "application/json" },
    responseBody: { ok: true },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  },
  varName,
  produces: [],
  isMultipart: multipart,
  isCrossDomain: false,
});

const emit = () =>
  emitMultiStepExecuteHttp(
    [
      mk(
        "https://api.example.test/jobs/recorded-slug/apply?date=2024-01-01",
        "https://api.example.test/jobs/recorded-slug/apply?date=2024-01-01",
        false,
        "r0"
      ),
      mk(
        "https://api.example.test/upload/files",
        "https://api.example.test/jobs/recorded-slug/upload?date=2024-01-01",
        true,
        "r1"
      ),
    ] as never,
    {},
    { stringMessageKey: null, nestedErrorPaths: [] },
    new Map(),
    new Set(),
    new Map(),
    new Set(),
    new Map(),
    new Map(),
    "https://api.example.test",
    new Map([["Referer", "https://api.example.test/jobs/recorded-slug/apply?date=2024-01-01"]]),
    new Map(),
    null,
    new Map(),
    new Map([
      ["recorded-slug", "payload.slug"],
      ["2024-01-01", "payload.date"],
    ])
  );

describe("Referer derived per call", () => {
  it("emits Referer from context.baseUrl in both builders", () => {
    const body = emit();
    expect(body).toContain("context.baseUrl");
    const refLines = body.split("\n").filter((l) => /Referer/.test(l));
    expect(refLines.length).toBeGreaterThan(0);
    for (const l of refLines) {
      expect(l).not.toContain("recorded-slug");
      expect(l).not.toContain("2024-01-01");
    }
  });
});

describe("Referer never reads prior responses", () => {
  it("uses only payload accessors and context.baseUrl for the Referer lines", () => {
    const refLines = emit()
      .split("\n")
      .filter((l) => /Referer/.test(l));
    expect(refLines.length).toBeGreaterThan(0);
    for (const l of refLines) {
      expect(l).not.toMatch(/\br[01]\b\s*(\.|\?\.|\[)/);
      expect(l).not.toMatch(/response|\.json\(\)|\.body/i);
    }
    expect(refLines.join("\n")).toContain("payload.slug");
  });

  it("keeps an unrelated recorded Referer path literal, rebased on baseUrl", () => {
    const body = emitMultiStepExecuteHttp(
      [
        mk(
          "https://api.example.test/jobs/recorded-slug/apply",
          "https://api.example.test/elsewhere/page?x=1",
          false,
          "r0"
        ),
      ] as never,
      {},
      { stringMessageKey: null, nestedErrorPaths: [] },
      new Map(),
      new Set(),
      new Map(),
      new Set(),
      new Map(),
      new Map(),
      "https://api.example.test",
      new Map([["Referer", "https://api.example.test/elsewhere/page?x=1"]]),
      new Map(),
      null,
      new Map(),
      new Map([["recorded-slug", "payload.slug"]])
    );
    const refLines = body.split("\n").filter((l) => /Referer/.test(l));
    expect(refLines.length).toBeGreaterThan(0);
    const joined = refLines.join("\n");
    expect(joined).toContain("context.baseUrl");
    expect(joined).toContain("/elsewhere/page?x=1");
    expect(joined).not.toContain("payload.slug");
    expect(joined).not.toMatch(/\br0\b\s*(\.|\?\.|\[)/);
  });
});
