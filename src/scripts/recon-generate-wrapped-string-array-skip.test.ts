import { describe, expect, it } from "vitest";
import { emitMultiStepExecuteHttp } from "@/scripts/recon-generate";
import { buildStep } from "@/scripts/recon-generate-multicall-fixture";

function emit(inputBody: unknown): { code: string; structured: Map<string, string> } {
  const step = buildStep("r1", {
    url: "https://api.example.com/orders",
    requestPostData: JSON.stringify(inputBody),
    responseBody: { ok: true },
    timestamp: "2026-01-01T00:00:00.000Z",
  });
  const structured = new Map<string, string>();
  const code = emitMultiStepExecuteHttp(
    [step] as unknown as Parameters<typeof emitMultiStepExecuteHttp>[0],
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
    new Map(),
    null,
    new Map(),
    new Map(),
    new Set(),
    [],
    structured
  );
  return { code, structured };
}

describe("string array nested under a wrapper object", () => {
  it("leaves the leaf to the structured pass: no flattened orderCartTags accessor", () => {
    const { code } = emit({ order: { cart: { tags: ["alpha-tag", "beta-tag"] } } });
    expect(code).not.toContain("orderCartTags");
  });

  it("still binds a top-level array of strings by index (no wrapper to skip)", () => {
    const { code } = emit({ tags: ["alpha-tag", "beta-tag"] });
    expect(code).toContain("payload.tags");
  });
});
