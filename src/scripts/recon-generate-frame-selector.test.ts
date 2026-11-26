import { describe, expect, it } from "vitest";

import { emitBrowserFlowTs } from "@/scripts/recon-generate";

/** Minimal opts that satisfy emitBrowserFlowTs for a submission flow. Kept
 * separate per this file's own fixture rather than imported from
 * recon-generate.test.ts, so this file stays disjoint from the sibling
 * suite's capture chain. */
const BASE_OPTS = {
  siteId: "recon-site-3",
  pascal: "ReconSite3",
  baseUrl: "https://careers.example.org",
  isSubmissionFlow: true,
  flowSteps: ["Click the Manual Application button"],
};

describe("emitBrowserFlowTs — frameSelector emission into runHealingFlow", () => {
  it("emits a runHealingFlow call whose deps carry the flow's frameSelector, so a generated plugin inherits cross-origin iframe capability", () => {
    const { code } = emitBrowserFlowTs({
      ...BASE_OPTS,
      frameSelector: "#apply_frame",
    });

    expect(code).toMatch(/runHealingFlow\(\{[\s\S]*frameSelector: "#apply_frame",[\s\S]*\}\)/);
  });

  it("omits the frameSelector key entirely when the flow declares none — byte-identical to today's output for every existing site", () => {
    const withoutFrameSelector = emitBrowserFlowTs({ ...BASE_OPTS });

    expect(withoutFrameSelector.code).not.toContain("frameSelector");
  });

  it("produces the exact same code whether frameSelector is omitted or explicitly undefined, so existing generated sites see no diff", () => {
    const omitted = emitBrowserFlowTs({ ...BASE_OPTS });
    const explicitUndefined = emitBrowserFlowTs({ ...BASE_OPTS, frameSelector: undefined });

    expect(explicitUndefined.code).toEqual(omitted.code);
  });
});

describe("emitBrowserFlowTs — per-step frameSelector emission", () => {
  it("emits frameSelector on the step object that declares it, and only there", () => {
    const { code } = emitBrowserFlowTs({
      ...BASE_OPTS,
      flowSteps: [
        { step: "Click the Manual Application button", frameSelector: "#step_frame" },
        "Click Next",
      ],
    });
    expect(code).toMatch(
      /instruction: "Click the Manual Application button",[^\n]*frameSelector: "#step_frame" \},/
    );
    expect(code.match(/#step_frame/g)).toHaveLength(1);
  });
});

describe("emitBrowserFlowTs — per-step frameSelector literal validity", () => {
  const SEL = "iframe[src^='https://example-pay.test']";
  const arrayOf = (code: string): string => {
    const lines = code.split("\n").filter((l) => /^ {2}\{ instruction:/.test(l));
    return `[${lines.join("\n")}]`;
  };
  // TypeScript 7 exposes no JS parser API; the step literals are plain JS
  // object literals, so constructing a Function over them is a syntax check
  // (a dropped comma throws SyntaxError at construction, same as TS1005).
  const parses = async (src: string): Promise<number> => {
    try {
      new Function("payload", `return ${src};`);
      return 0;
    } catch {
      return 1;
    }
  };

  it("separates frameSelector with a comma on a declareOnly submitStep:false step", async () => {
    const { code } = emitBrowserFlowTs({
      ...BASE_OPTS,
      flowSteps: [
        { step: "Click Pay", submitStep: false, payloadField: "email", frameSelector: SEL },
        { step: "Click Next", submitStep: false },
      ],
    });
    expect(code).toContain(`submitStep: false, frameSelector: ${JSON.stringify(SEL)} },`);
    expect(await parses(arrayOf(code))).toBe(0);
  });

  it("is valid for navigateTo, emailStep, password and last-step-submit shapes", async () => {
    const { code } = emitBrowserFlowTs({
      ...BASE_OPTS,
      flowSteps: [
        { step: "Go", navigateTo: "https://careers.example.org/a", frameSelector: SEL },
        { step: "Confirm email", emailStep: true, frameSelector: SEL },
        { step: "Type $" + "{RECON_PASSWORD}", frameSelector: SEL },
        { step: "Click Submit", frameSelector: SEL },
      ],
    });
    expect(code.match(/, frameSelector: /g)!.length).toBeGreaterThanOrEqual(4);
    expect(code).toMatch(/submitStep: true, frameSelector: [^\n]* \},\n/);
    expect(await parses(arrayOf(code))).toBe(0);
  });
});
