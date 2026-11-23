import { describe, expect, it } from "vitest";
import {
  compileActionSteps,
  emitMultiStepExecuteHttp,
  indexStateValues,
} from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sigsigsigsig";
const COOKIE = "sessionid=abcdef123456zzz";

describe("recon-generate credential headers", () => {
  it("never emits Authorization/Cookie/x-*-token literals", () => {
    const captures = [
      buildCapture({
        url: "https://api.example.com/a/login/",
        requestPostData: JSON.stringify({ q: "one" }),
        responseBody: { ok: true },
        timestamp: "2024-09-01T00:00:00Z",
      }),
      buildCapture({
        url: "https://api.example.com/a/submit/",
        requestPostData: JSON.stringify({ q: "one" }),
        responseBody: { ok: true },
        requestHeaders: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${JWT}`,
          Cookie: COOKIE,
          "X-Csrf-Token": "csrfvalue987654321",
        },
        timestamp: "2024-09-01T00:00:01Z",
      }),
    ];
    const inputBody = JSON.parse(captures[0]!.requestPostData ?? "null") as unknown;
    const steps = compileActionSteps(
      captures.map((capture, index) => ({ capture, index })) as never,
      indexStateValues(captures)
    );
    const body = emitMultiStepExecuteHttp(
      steps as unknown as Parameters<typeof emitMultiStepExecuteHttp>[0],
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
    expect(body).not.toContain(JWT);
    expect(body).not.toContain("abcdef123456zzz");
    expect(body).not.toContain("csrfvalue987654321");
    expect(body).toContain("TODO: Authorization");
    expect(body).toContain("throw new Error");
  });
});
