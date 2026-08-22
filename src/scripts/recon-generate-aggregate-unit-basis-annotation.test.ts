import { describe, expect, it } from "vitest";
import { emitContractTs } from "@/scripts/recon-generate";

const BASE_OPTS = {
  siteId: "test-site",
  pascal: "TestSite",
  baseUrl: "https://example.com",
  baseHeaders: { "Content-Type": "application/json" },
  minTime: 100,
  safeRps: 10,
  gql: false,
  gqlQuery: null,
  endpointPath: "/api/example",
  auxFiles: [],
};

describe("emitContractTs — aggregate/per-unit basis annotation", () => {
  it("attaches .describe() naming the breakdown path to the aggregate field when the shape is detected", () => {
    const samples = [
      {
        price: {
          summary: { total: 30 },
          breakdownByUnit: {
            a: { total: 10 },
            b: { total: 20 },
          },
        },
      },
      {
        price: {
          summary: { total: 15 },
          breakdownByUnit: {
            a: { total: 5 },
            b: { total: 10 },
          },
        },
      },
    ];
    const contract = emitContractTs({
      ...BASE_OPTS,
      responseBody: samples[0],
      responseBodySamples: samples,
    });
    expect(contract).toMatch(/total: z\.number\(\)\.describe\(.*breakdownByUnit.*\)/);
  });

  it("emits byte-for-byte unchanged output when no such shape is present", () => {
    const responseBody = { id: "abc", active: true };
    const contract = emitContractTs({ ...BASE_OPTS, responseBody });
    expect(contract).not.toContain(".describe(");
  });

  it("describes every sibling breakdown that independently confirms the same aggregate, not just the last one found", () => {
    // Both breakdownA and breakdownB are per-entry maps whose "total" sums
    // equal price.summary.total in every sample -- two independent, equally
    // valid derivations for the same aggregate field.
    const samples = [
      {
        price: {
          summary: { total: 30 },
          breakdownA: { a: { total: 10 }, b: { total: 20 } },
          breakdownB: { x: { total: 12 }, y: { total: 18 } },
        },
      },
      {
        price: {
          summary: { total: 15 },
          breakdownA: { a: { total: 5 }, b: { total: 10 } },
          breakdownB: { x: { total: 6 }, y: { total: 9 } },
        },
      },
    ];
    const contract = emitContractTs({
      ...BASE_OPTS,
      responseBody: samples[0],
      responseBodySamples: samples,
    });
    const describeMatch = contract.match(/total: z\.number\(\)\.describe\(([^)]*)\)/);
    expect(describeMatch).not.toBeNull();
    const describeText = describeMatch![1]!;
    expect(describeText).toContain("breakdownA");
    expect(describeText).toContain("breakdownB");
  });
});
