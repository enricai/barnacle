import { describe, expect, it } from "vitest";
import { detectDrillDownFoldPlan } from "@/scripts/recon-generate";
import { buildStep, type MulticallFixtureStep } from "@/scripts/recon-generate-multicall-fixture";

const URL_ = "https://api.example.com/search/";

function steps(): MulticallFixtureStep[] {
  return [
    buildStep("r0", {
      url: URL_,
      requestPostData: '{"q":"x"}',
      responseBody: { results: [{ sku: "SKU-1", name: "Widget" }] },
      timestamp: "2024-01-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: URL_,
      requestPostData: '{"sku":"SKU-1"}',
      responseBody: { detail: [{ sku: "SKU-1", price: 5 }] },
      timestamp: "2024-01-01T00:00:01Z",
    }),
  ];
}

type Arg = Parameters<typeof detectDrillDownFoldPlan>[2];
const run = (allow: Arg) =>
  detectDrillDownFoldPlan(
    steps() as unknown as Parameters<typeof detectDrillDownFoldPlan>[0],
    null,
    allow
  );

describe("detectDrillDownFoldPlan same-endpoint gate accepts a per-capture predicate", () => {
  it("boolean false drops the same-endpoint drill", () => {
    expect(run(false)).toHaveLength(0);
  });
  it("a predicate returning false drops it, and receives the drill capture", () => {
    const seen: string[] = [];
    expect(
      run((c) => {
        seen.push(c.requestPostData ?? "");
        return false;
      })
    ).toHaveLength(0);
    expect(seen).toContain('{"sku":"SKU-1"}');
  });
  it("a predicate returning true admits it", () => {
    expect(run(() => true).length).toBeGreaterThan(0);
    expect(run(true).length).toBeGreaterThan(0);
  });
});
