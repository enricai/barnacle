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

  it("does not annotate when the only evidence is a single-entry breakdown in a single sample", () => {
    // One sample, one breakdown entry: aggregate equals the sole unit value
    // trivially and proves nothing about summation.
    const responseBody = {
      price: {
        summary: { total: 30 },
        breakdownByUnit: {
          a: { total: 30 },
        },
      },
    };
    const contract = emitContractTs({ ...BASE_OPTS, responseBody });
    expect(contract).not.toContain(".describe(");
  });

  it("does not annotate when the aggregate/unit ratio varies across samples", () => {
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
            b: { total: 5 },
          },
        },
      },
    ];
    const contract = emitContractTs({
      ...BASE_OPTS,
      responseBody: samples[0],
      responseBodySamples: samples,
    });
    expect(contract).not.toContain(".describe(");
  });

  it("does not annotate an aggregate field with no nested per-unit breakdown anywhere in the payload", () => {
    const samples = [
      { price: { summary: { total: 30 }, currency: "USD" } },
      { price: { summary: { total: 15 }, currency: "USD" } },
    ];
    const contract = emitContractTs({
      ...BASE_OPTS,
      responseBody: samples[0],
      responseBodySamples: samples,
    });
    expect(contract).not.toContain(".describe(");
  });

  it("does not annotate two unrelated numeric fields whose ratio matches only incidentally in one sample", () => {
    // total = count * 15 only in the first sample; no map-of-objects
    // breakdown exists anywhere, so there is no candidate pair to evaluate.
    const samples = [
      { total: 30, count: 2 },
      { total: 15, count: 7 },
    ];
    const contract = emitContractTs({
      ...BASE_OPTS,
      responseBody: samples[0],
      responseBodySamples: samples,
    });
    expect(contract).not.toContain(".describe(");
  });
});
