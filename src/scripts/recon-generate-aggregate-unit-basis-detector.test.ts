import { describe, expect, it } from "vitest";

import { detectAggregateUnitBasisFindings } from "@/scripts/recon-generate";

/**
 * Locks in the report's party-total/per-guest-breakdown shape and the
 * false-positive guards the detector must apply: a single-entry breakdown
 * proves nothing, a ratio that only holds on some samples is coincidence
 * not aggregation, and a breakdown entry missing the shared field
 * disqualifies the whole pair.
 */
describe("detectAggregateUnitBasisFindings", () => {
  it("finds the aggregate/per-unit pair when the sum relation holds in every sample", () => {
    const samples = [
      {
        price: {
          summary: { total: 300 },
          breakdownByGuest: {
            guest1: { total: 100 },
            guest2: { total: 200 },
          },
        },
      },
      {
        price: {
          summary: { total: 90 },
          breakdownByGuest: {
            guest1: { total: 30 },
            guest2: { total: 60 },
          },
        },
      },
    ];

    const findings = detectAggregateUnitBasisFindings(samples);

    expect(findings).toEqual([
      expect.objectContaining({
        aggregatePath: ["price", "summary", "total"],
        breakdownPath: ["price", "breakdownByGuest"],
        unitFieldName: "total",
        sampleCount: 2,
        maxBreakdownEntries: 2,
      }),
    ]);
  });

  it("does not find a finding when every breakdown is single-entry", () => {
    const samples = [
      {
        price: {
          summary: { total: 100 },
          breakdownByGuest: { guest1: { total: 100 } },
        },
      },
      {
        price: {
          summary: { total: 50 },
          breakdownByGuest: { guest1: { total: 50 } },
        },
      },
    ];

    expect(detectAggregateUnitBasisFindings(samples)).toEqual([]);
  });

  it("does not find a finding when the sum relation only holds in some samples", () => {
    const samples = [
      {
        price: {
          summary: { total: 300 },
          breakdownByGuest: {
            guest1: { total: 100 },
            guest2: { total: 200 },
          },
        },
      },
      {
        price: {
          summary: { total: 999 },
          breakdownByGuest: {
            guest1: { total: 30 },
            guest2: { total: 60 },
          },
        },
      },
    ];

    expect(detectAggregateUnitBasisFindings(samples)).toEqual([]);
  });

  it("does not find a finding when a breakdown entry is missing the shared field", () => {
    const samples = [
      {
        price: {
          summary: { total: 300 },
          breakdownByGuest: {
            guest1: { total: 100 },
            guest2: { fee: 200 },
          },
        },
      },
    ];

    expect(detectAggregateUnitBasisFindings(samples)).toEqual([]);
  });

  it("returns no findings for empty samples", () => {
    expect(detectAggregateUnitBasisFindings([])).toEqual([]);
  });
});
