import { describe, expect, it } from "vitest";

import { emitBrowserFlowTs, emitContractTs, emitIndexTs } from "@/scripts/recon-generate";

const base = {
  siteId: "s",
  pascal: "S",
  baseUrl: "https://example.com",
  isSubmissionFlow: false,
};
const steps = ["click the login button", "click the next button"];

describe("empty mixed tail", () => {
  it("emits a handover-only flow", () => {
    const { code } = emitBrowserFlowTs({
      ...base,
      flowSteps: steps,
      mixedHandover: { tailFromStep: steps.length },
    });
    expect(code).toContain("sessionCookies");
    expect(code).not.toContain("executeHttp throws");
    expect(code).not.toContain("TODO: no flow steps were parsed");
    expect(code).not.toContain("payload");
    expect(code).not.toContain("guardedExtract");
    expect(code).not.toContain("extract");
  });
  it("leaves a non-empty tail unchanged", () => {
    const { code } = emitBrowserFlowTs({
      ...base,
      flowSteps: steps,
      mixedHandover: { tailFromStep: 1 },
    });
    expect(code).toContain("executeHttp throws");
    expect(code).toContain("guardedExtract");
  });
  it("index header for a mixed flow does not say to load alone", () => {
    const mixed = emitIndexTs({ siteId: "s", pascal: "S", mixedHandover: true });
    expect(mixed).toContain("do not load this module alone");
    expect(mixed).not.toContain("BARNACLE_PLUGINS=./dist");
    expect(emitIndexTs({ siteId: "s", pascal: "S" })).toContain("BARNACLE_PLUGINS=./dist");
  });
});

describe("empty mixed tail: contract call site agrees with the generated flow", () => {
  it("execute() passes exactly the params the handover-only flow declares, and the flow's return type is the contract's response type", () => {
    const flowSteps = ["click the login button"];
    const mixedHandover = { tailFromStep: flowSteps.length };
    const contract = emitContractTs({
      siteId: "s",
      pascal: "S",
      baseUrl: "https://example.com",
      baseHeaders: {},
      minTime: 100,
      safeRps: 10,
      responseBody: { ok: true },
      gql: false,
      gqlQuery: null,
      endpointPath: "/api/x",
      auxFiles: [],
      isSubmissionFlow: false,
      flowSteps,
      multiStepBody: "    return { cookies: {} };",
      mixedHttpPrefix: true,
      mixedHandover,
    } as never);
    const { code: flow } = emitBrowserFlowTs({
      ...base,
      flowSteps,
      mixedHandover,
    });
    const call = contract.match(/await runSBrowserFlow\(([^)]*(?:\([^)]*\)[^)]*)*)\);/);
    expect(call).not.toBeNull();
    const sig = flow.match(/export async function runSBrowserFlow\(([\s\S]*?)\): Promise<(\w+)>/);
    expect(sig).not.toBeNull();
    const declared = (sig?.[1] ?? "")
      .replace(/<[^>]*>/g, "")
      .split(",")
      .filter((p) => p.trim()).length;
    const passed = (call?.[1] ?? "").split(",").filter((p) => p.trim()).length;
    expect(passed).toBe(declared);
    expect(call?.[1]).toContain("cookies");
    expect(call?.[1]).not.toContain("payload,");
    expect(sig?.[2]).toBe("SResponse");
    expect(contract).toMatch(/export type SResponse\b/);
    expect(contract).toContain("raw as SResponse");
  });
});
