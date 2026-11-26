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
