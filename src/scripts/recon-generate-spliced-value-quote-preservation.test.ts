import { describe, expect, it } from "vitest";
import type { ReconVocabulary } from "@/recon/vocabulary";
import { parseFillStep, parseSelectStep } from "@/scraper/flow-runner";
import { emitBrowserFlowTs, emitConfigManifest } from "@/scripts/recon-generate";

/**
 * Locks that a spliced persona value keeps its quote delimiters, so emitted
 * instructions read `'${payload.X}'` / `'{{ .request.x }}'` and the runtime
 * parsers (which anchor on the opening quote) still match the rendered step.
 */

const VOCAB: ReconVocabulary = {
  subject: /\b(the\s+)?(applicant|candidate)'?s\b/i,
  exclusions: [],
  table: [
    [/\bcity\b/i, "City"],
    [/\bfirst name\b/i, "FirstName"],
    [/\blast name\b/i, "LastName"],
  ],
};

const PAYLOAD_CITY = `$${"{escapeQuotedValue(payload.City)}"}`;
const PASSWORD_TOKEN = `$${"{RECON_PASSWORD}"}`;

function flowStepsBlock(code: string): string {
  const match = /const FLOW_STEPS: HealingFlowStep\[\] = \[([\s\S]*?)\n {2}\];/.exec(code);
  if (!match) throw new Error("FLOW_STEPS block not found in emitted code");
  return match[1]!;
}

function emitFlow(flowSteps: string[]): string {
  const { code } = emitBrowserFlowTs({
    siteId: "test-agency",
    pascal: "TestAgency",
    baseUrl: "https://example.com",
    isSubmissionFlow: true,
    vocabulary: VOCAB,
    flowSteps,
  });
  return flowStepsBlock(code);
}

function manifestSteps(flowSteps: unknown[]): string[] {
  const str = emitConfigManifest({
    siteId: "acme-demo",
    displayName: "AcmeDemo",
    baseUrl: "https://apply.acme.example",
    vocabulary: VOCAB,
    flowSteps: flowSteps as never,
  } as never);
  const manifest = JSON.parse(str) as {
    spec: { flow: { steps: (string | { step: string })[] } };
  };
  return manifest.spec.flow.steps.map((s) => (typeof s === "string" ? s : s.step));
}

describe("spliced persona values keep their quote delimiters", () => {
  it("emitBrowserFlowTs keeps quotes around a single payload accessor", () => {
    const block = emitFlow(["Fill in the City field with 'Dallas'"]);

    expect(block).toContain(`Fill in the City field with '${PAYLOAD_CITY}'`);
    expect(block).not.toContain("Dallas");
  });

  it("emitBrowserFlowTs keeps quotes around a composite value", () => {
    const block = emitFlow([
      "Type 'Reginald' into the First Name field",
      "Type 'Reconaldo' into the Last Name field",
      "Type 'Reconaldo Reginald' into the digital signature field",
    ]);

    expect(block).toContain(`'$${"{escapeQuotedValue(payload.LastName)}"} $${"{escapeQuotedValue(payload.FirstName)}"}'`);
  });

  it("emitConfigManifest keeps quotes around the request template", () => {
    const [step] = manifestSteps([
      { step: "Fill in the City field with 'Dallas'", payloadField: "City" },
    ]);

    expect(step).toBe("Fill in the City field with '{{ .request.City }}'");
  });

  it("leaves the password env-token form unchanged", () => {
    const block = emitFlow([`Fill in the Password field with '${PASSWORD_TOKEN}'`]);

    expect(block).toContain("'$" + "{throwawayPassword}'");
    expect(block).not.toContain(PASSWORD_TOKEN);
  });

  it("escapes template-literal metacharacters in the untouched prefix while keeping the quoted splice", () => {
    const block = emitFlow(["Fill in the City field (note: `a`) with 'Dallas'"]);

    expect(block).toContain(`(note: \\\`a\\\`) with '${PAYLOAD_CITY}'`);
  });

  it("round-trips the emitted fill template through parseFillStep", () => {
    const block = emitFlow(["Fill in the City field with 'Dallas'"]);
    const template = /`([^`]*)`/.exec(block)?.[1] ?? "";
    const rendered = template.replace(PAYLOAD_CITY, "Fort Worth");

    expect(parseFillStep(rendered)).toEqual({ fieldLabel: "City", value: "Fort Worth" });
  });

  it("round-trips the manifest fill template through parseFillStep", () => {
    const [step] = manifestSteps([
      { step: "Fill in the City field with 'Dallas'", payloadField: "City" },
    ]);
    const rendered = (step ?? "").replace("{{ .request.City }}", "Fort Worth");

    expect(parseFillStep(rendered)).toEqual({ fieldLabel: "City", value: "Fort Worth" });
  });

  it("round-trips a select step through parseSelectStep", () => {
    const [step] = manifestSteps([
      { step: "Select 'Texas' for the 'State' dropdown", payloadField: "State" },
    ]);
    const rendered = (step ?? "").replace("{{ .request.State }}", "Ohio");

    expect(step).toContain("'{{ .request.State }}'");
    expect(parseSelectStep(rendered)?.option).toBe("Ohio");
  });
});
