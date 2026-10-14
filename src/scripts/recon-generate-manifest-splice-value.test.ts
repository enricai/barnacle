import { describe, expect, it } from "vitest";
import { CONFIG_PLUGIN_MANIFEST } from "@/plugins/config-plugin";
import type { ReconVocabulary } from "@/recon/vocabulary";
import { parseFillStep } from "@/scraper/flow-runner";
import { emitConfigManifest } from "@/scripts/recon-generate";

/** Recruiting-domain test vocabulary, exercised only by this unit test. */
const TEST_RECRUITING_VOCABULARY: ReconVocabulary = {
  subject: /\b(the\s+)?(test\s+)?(candidate|applicant)'?s\b/i,
  exclusions: [],
  table: [[/\bfirst name\b/i, "FirstName"]],
};

type ManifestStep = string | { step: string };

function firstStepText(manifestStr: string): string {
  const manifest = JSON.parse(manifestStr) as { spec: { flow: { steps: ManifestStep[] } } };
  const step = manifest.spec.flow.steps[0];
  if (step === undefined) {
    throw new Error("manifest has no flow steps");
  }
  return typeof step === "string" ? step : step.step;
}

describe("emitConfigManifest — buildManifestInstruction splices the fill VALUE, never the selector", () => {
  const flowSteps = [
    {
      step: "Fill in the Legal Name First Name field (data-automation-id='legalName--firstName') with 'Reginald'",
      payloadField: "FirstName",
    },
  ];

  it("splices {{ .request.FirstName }} at the trailing value, leaving the selector attribute byte-for-byte unchanged", () => {
    const manifestStr = emitConfigManifest({
      siteId: "acme-demo",
      displayName: "AcmeDemo",
      baseUrl: "https://apply.acme.example",
      flowSteps,
    });

    expect(firstStepText(manifestStr)).toBe(
      "Fill in the Legal Name First Name field (data-automation-id='legalName--firstName') with '{{ .request.FirstName }}'"
    );
  });

  it("emits an instruction parseFillStep accepts once rendered with a value", () => {
    const manifestStr = emitConfigManifest({
      siteId: "acme-demo",
      displayName: "AcmeDemo",
      baseUrl: "https://apply.acme.example",
      flowSteps: [{ step: "Fill in the City field with 'Dallas'", payloadField: "City" }],
    });
    const rendered = firstStepText(manifestStr).replace("{{ .request.City }}", "Ada");

    expect(parseFillStep(rendered)?.value).toBe("Ada");
  });

  it("lands on the same site when the field is vocabulary-resolved rather than explicit", () => {
    const manifestStr = emitConfigManifest({
      siteId: "acme-demo",
      displayName: "AcmeDemo",
      baseUrl: "https://apply.acme.example",
      flowSteps: [
        {
          step: "Fill in the Legal Name First Name field (data-automation-id='legalName--firstName') with 'Reginald'",
        },
      ],
      vocabulary: TEST_RECRUITING_VOCABULARY,
    });

    expect(firstStepText(manifestStr)).toBe(
      "Fill in the Legal Name First Name field (data-automation-id='legalName--firstName') with '{{ .request.FirstName }}'"
    );
  });
});

describe("emitConfigManifest — spec.multipart follows the shared Resume-contract decision", () => {
  const base = {
    siteId: "acme-demo",
    baseUrl: "https://apply.acme.example",
    isSubmissionFlow: true,
  };
  const uploadFlow = [
    "Fill in the City field with 'Dallas'",
    { step: "Upload the resume", upload: true },
    { step: "Click Submit", submitStep: true },
  ];
  const specOf = (manifestStr: string): ReturnType<typeof CONFIG_PLUGIN_MANIFEST.parse>["spec"] =>
    CONFIG_PLUGIN_MANIFEST.parse(JSON.parse(manifestStr)).spec;

  it("emits multipart: true for an upload step in a flow with the Resume contract", () => {
    const spec = specOf(
      emitConfigManifest({ ...base, flowSteps: uploadFlow, hasMultipartStep: true })
    );

    expect(spec.multipart).toBe(true);
  });

  it("emits multipart: true when the Resume contract is inferred from the input body", () => {
    const spec = specOf(
      emitConfigManifest({ ...base, flowSteps: uploadFlow, inputBody: { Email: "a@b.c" } })
    );

    expect(spec.multipart).toBe(true);
  });

  it("emits no multipart without an upload step", () => {
    const spec = specOf(
      emitConfigManifest({
        ...base,
        flowSteps: ["Fill in the City field with 'Dallas'"],
        hasMultipartStep: true,
      })
    );

    expect(spec.multipart).toBeUndefined();
  });

  it("emits no multipart without the Resume contract", () => {
    const spec = specOf(emitConfigManifest({ ...base, flowSteps: uploadFlow }));

    expect(spec.multipart).toBeUndefined();
  });
});
