import { describe, expect, it } from "vitest";
import { emitMultiStepExecuteHttp } from "@/scripts/recon-generate";
import { buildStep } from "@/scripts/recon-generate-multicall-fixture";

const AUTHZ_URL = "https://api.example.com/listings-avail-api/authz/private";
const AVAILABLE_UNITS_URL = "https://api.example.com/listings-avail-api/available-units/";

/**
 * Reproduces feat-001: a multi-step flow whose SECOND call's own captured
 * response nests a per-unit breakdown under an aggregate total -- the same
 * shape `emitContractTs`'s test fixture (recon-generate-aggregate-unit-basis-
 * annotation.test.ts) confirms gets a `.describe()` on the client-level
 * schema.
 */
function buildStepsWithAggregateShapeOnSecondCall() {
  return [
    buildStep("r0", {
      url: AUTHZ_URL,
      requestPostData: "{}",
      responseBody: { result: "anonymous", successful: true },
      timestamp: "2024-01-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: AVAILABLE_UNITS_URL,
      requestPostData: "{}",
      responseBody: {
        price: {
          summary: { total: 30 },
          breakdownByUnit: {
            a: { total: 10 },
            b: { total: 20 },
          },
        },
      },
      timestamp: "2024-01-01T00:00:01Z",
    }),
  ];
}

describe("emitMultiStepExecuteHttp — per-call aggregate/per-unit basis annotation", () => {
  it("attaches .describe() naming the breakdown path on the call whose own response has the shape", () => {
    const actionSteps = buildStepsWithAggregateShapeOnSecondCall();

    const body = emitMultiStepExecuteHttp(
      actionSteps as unknown as Parameters<typeof emitMultiStepExecuteHttp>[0],
      null,
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

    expect(body).toMatch(/total: z\.number\(\)\.describe\(.*breakdownByUnit.*\)/);
  });

  it("emits no .describe() on calls whose own response has no aggregate/per-unit shape", () => {
    const actionSteps = [
      buildStep("r0", {
        url: AUTHZ_URL,
        requestPostData: "{}",
        responseBody: { result: "anonymous", successful: true },
        timestamp: "2024-01-01T00:00:00Z",
      }),
    ];

    const body = emitMultiStepExecuteHttp(
      actionSteps as unknown as Parameters<typeof emitMultiStepExecuteHttp>[0],
      null,
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

    expect(body).not.toContain(".describe(");
  });
});
