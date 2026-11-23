import { describe, expect, it } from "vitest";
import { emitBrowserFlowTs, emitConfigManifest } from "@/scripts/recon-generate";

const steps = (submit: boolean | undefined) => [
  "Click the Continue button",
  {
    step: "Click the Pay button (do NOT click Pay)",
    declareOnly: true,
    ...(submit === undefined ? {} : { submitStep: submit }),
  },
];

function ts(s: ReturnType<typeof steps>, isSubmissionFlow = true): string {
  return emitBrowserFlowTs({
    siteId: "t",
    pascal: "T",
    baseUrl: "https://example.com",
    isSubmissionFlow,
    flowSteps: s,
  }).code;
}

function manifestSteps(s: ReturnType<typeof steps>, isSubmissionFlow = true): unknown[] {
  const out = emitConfigManifest({
    siteId: "t",
    baseUrl: "https://example.com",
    flowSteps: s,
    isSubmissionFlow,
  } as never) as unknown as string | { steps?: unknown[] };
  const json = typeof out === "string" ? JSON.parse(out) : out;
  return json.spec.flow.steps;
}

describe("declare-only steps are emitted", () => {
  it("emits submitStep:true for a declareOnly step in browser-flow.ts", () => {
    const out = ts(steps(true), false);
    expect(out).toMatch(
      /instruction: "Click the Pay button[^"]*", optional: false, upload: false, submitStep: true/
    );
  });
  it("emits the step in the manifest with submitStep:true", () => {
    const last = manifestSteps(steps(true), false).at(-1) as Record<string, unknown>;
    expect(last.submitStep).toBe(true);
    expect(String(last.step)).toContain("Pay button");
  });
  it("does not infer submitStep from do-NOT-click wording without the flag", () => {
    const out = ts(steps(undefined), false);
    expect(out).toMatch(/Pay button[^"]*", optional: false, upload: false, submitStep: false/);
    const last = manifestSteps(steps(undefined), false).at(-1);
    expect(typeof last === "string" || (last as { submitStep: boolean }).submitStep === false).toBe(
      true
    );
  });
});
