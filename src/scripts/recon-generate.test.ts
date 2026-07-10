import { describe, expect, it } from "vitest";

import { CONFIG_PLUGIN_API_VERSION, CONFIG_PLUGIN_KIND } from "@/plugins/plugin-manifest-envelope";
import {
  emitBrowserFlowTs,
  emitConfigManifest,
  emitContractTs,
  emitMultiStepExecuteHttp,
  resolveStepPayloadField,
} from "@/scripts/recon-generate";

/** The recon env-var token for the applicant email, built by concatenation so
 * Biome's noTemplateCurlyInString rule doesn't flag the literal `${...}`. */
const RECON_EMAIL_TOKEN = `$${"{RECON_EMAIL}"}`;
/** Splice reference the emitter injects, e.g. `${payload.FirstName}`. */
function payloadRef(field: string): string {
  return `$${`{payload.${field}}`}`;
}

/** Minimal opts that satisfy the emitter for a non-multipart plugin. */
const BASE_OPTS = {
  siteId: "test-site",
  pascal: "TestSite",
  baseUrl: "https://example.com",
  baseHeaders: { "Content-Type": "application/json" },
  minTime: 100,
  safeRps: 10,
  responseBody: { id: "abc", active: true },
  gql: false,
  gqlQuery: null,
  endpointPath: "/api/search",
  auxFiles: [],
};

describe("emitContractTs — multipart plugin", () => {
  const source = emitContractTs({
    ...BASE_OPTS,
    hasMultipartStep: true,
    inputBody: { Name: "Alice", SmsOptIn: true, Score: 1 },
    multiStepBody: `    return { data: {} as unknown };`,
  });

  it("imports multipartBoolean from @/lib/zod-multipart", () => {
    expect(source).toContain('import { multipartBoolean } from "@/lib/zod-multipart"');
  });

  it("uses multipartBoolean() at boolean payload fields", () => {
    expect(source).toContain("multipartBoolean()");
  });

  it("does not emit an inline MULTIPART_BOOL const declaration", () => {
    expect(source).not.toContain("MULTIPART_BOOL");
    expect(source).not.toContain('z.preprocess(\n  (v) => (v === "true"');
  });
});

describe("emitContractTs — non-multipart plugin", () => {
  const source = emitContractTs({
    ...BASE_OPTS,
    hasMultipartStep: false,
    inputBody: { Name: "Alice", Active: true },
  });

  it("does not import multipartBoolean", () => {
    expect(source).not.toContain("multipartBoolean");
  });

  it("uses z.boolean() for boolean fields", () => {
    expect(source).toContain("z.boolean()");
  });
});

/** Minimal ActionStep with a multipart upload request. */
const MULTIPART_ACTION_STEP = {
  capture: {
    timestamp: "2024-01-01T00:00:00Z",
    phase: "action",
    method: "POST",
    url: "https://api.example.com/upload/files",
    status: 200,
    requestHeaders: { "Content-Type": "multipart/form-data", Accept: "application/json" },
    requestPostData: null,
    responseHeaders: { "content-type": "application/json" },
    responseBody: { success: true },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  },
  varName: "r0",
  produces: [],
  isMultipart: true,
  isCrossDomain: false,
};

describe("emitMultiStepExecuteHttp — multipart upload step", () => {
  const body = emitMultiStepExecuteHttp(
    [MULTIPART_ACTION_STEP],
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

  it('emits omitHeaderCaseInsensitive(BASE_HEADERS, "Content-Type") for the upload headers', () => {
    expect(body).toContain('omitHeaderCaseInsensitive(BASE_HEADERS, "Content-Type")');
  });

  it("does not emit the inline Object.fromEntries filter idiom", () => {
    expect(body).not.toContain("Object.fromEntries(Object.entries(BASE_HEADERS)");
  });
});

describe("emitContractTs — multipart plugin imports omitHeaderCaseInsensitive", () => {
  const source = emitContractTs({
    ...BASE_OPTS,
    hasMultipartStep: true,
    inputBody: { Name: "Alice", SmsOptIn: true },
    multiStepBody: `    return { data: {} as unknown };`,
  });

  it("imports omitHeaderCaseInsensitive from @/lib/case-insensitive-headers", () => {
    expect(source).toContain(
      'import { omitHeaderCaseInsensitive } from "@/lib/case-insensitive-headers"'
    );
  });
});

describe("emitContractTs — non-multipart plugin does not import omitHeaderCaseInsensitive", () => {
  const source = emitContractTs({
    ...BASE_OPTS,
    hasMultipartStep: false,
    inputBody: { Name: "Alice" },
  });

  it("does not import omitHeaderCaseInsensitive", () => {
    expect(source).not.toContain("omitHeaderCaseInsensitive");
  });
});

describe("resolveStepPayloadField — HCA-shaped positives", () => {
  const cases: Array<[string, string]> = [
    ["Fill in the First Name field with 'Reginald'", "FirstName"],
    ["Fill in the Last Name field with 'Barrington'", "LastName"],
    [`Enter ${RECON_EMAIL_TOKEN} in the Email Address field`, "Email"],
    ["Type '5125551234' into the Mobile Phone field", "MobilePhone"],
    ["Fill in the Street Address with '123 Main St'", "AddressLine1"],
    ["Enter 'Austin' in the City field", "City"],
    ["Select 'Texas' from the State dropdown", "State"],
    ["Type '78701' into the Zip Code field", "PostalCode"],
    ["Select 'United States' from the Country dropdown", "Country"],
  ];
  for (const [instruction, field] of cases) {
    it(`maps ${JSON.stringify(instruction)} → ${field}`, () => {
      expect(resolveStepPayloadField(instruction)).toBe(field);
    });
  }
});

describe("resolveStepPayloadField — trap negatives", () => {
  const traps = [
    "Fill in Reference #1 First Name with 'Priya'",
    "Enter the Company Phone in Employment History Row 1 as '5551239999'",
    "Type 'Reginald Barrington' into the Signature Name field",
    "Fill in any Full Name field with 'Reginald Barrington'",
    "Enter Today's Date as '2026-07-09'",
    "Type '5125550000' into the Secondary Phone Number field",
    // Screening questions: a candidate-label word ("state", "city") inside the
    // QUESTION text must not splice — the first quote is the question, not a
    // value. This is the real HCA step 42 shape (regression: "state" matched
    // the State label and corrupted the question quote into ${payload.State}).
    "For 'Are you currently licensed to work as a Registered Nurse in this state?' select 'Yes'",
    "For 'In which settings have you worked as a Registered Nurse during the past three years?' select 'Hospital'",
    "Click the 'No' answer for the question about common domicile with any employee",
  ];
  for (const instruction of traps) {
    it(`leaves ${JSON.stringify(instruction)} literal (null)`, () => {
      expect(resolveStepPayloadField(instruction)).toBeNull();
    });
  }
});

describe("resolveStepPayloadField — override + opt-out + no-constant", () => {
  it("honors an explicit payloadField override", () => {
    expect(resolveStepPayloadField("Click the Continue button", "FirstName")).toBe("FirstName");
  });

  it("returns null when forceNone is set even for a matching label", () => {
    expect(
      resolveStepPayloadField("Fill in the First Name field with 'Reginald'", undefined, true)
    ).toBeNull();
  });

  it("returns null when the instruction carries no spliceable constant", () => {
    expect(resolveStepPayloadField("Fill in the First Name field")).toBeNull();
  });
});

describe("emitBrowserFlowTs — payload splicing", () => {
  const { code, payloadFieldNames } = emitBrowserFlowTs({
    siteId: "test-site",
    pascal: "TestSite",
    baseUrl: "https://example.com",
    isSubmissionFlow: true,
    flowSteps: [
      "Fill in the First Name field with 'Reginald'",
      `Enter ${RECON_EMAIL_TOKEN} in the Email Address field`,
      "Select 'Decline to self-identify' from the Gender dropdown",
      { step: "Click the Submit Application button", submitStep: true },
    ],
  });

  it("splices a payload.FirstName reference for the Reginald step", () => {
    expect(code).toContain(payloadRef("FirstName"));
  });

  it("splices a payload.Email reference for the RECON_EMAIL step", () => {
    expect(code).toContain(payloadRef("Email"));
  });

  it("leaves the operational-default dropdown literal", () => {
    expect(code).toContain("Decline to self-identify");
  });

  it("emits no un-spliced Reginald or RECON_EMAIL token", () => {
    expect(code).not.toContain("Reginald");
    expect(code).not.toContain(RECON_EMAIL_TOKEN);
  });

  it("calls runHealingFlow and emits a FLOW_STEPS array", () => {
    expect(code).toContain("runHealingFlow(");
    expect(code).toContain("const FLOW_STEPS: HealingFlowStep[] = [");
  });

  it("waits for SPA hydration after navigating (so early steps don't skip a shell page)", () => {
    expect(code).toContain("import { type HealingFlowStep, runHealingFlow, waitForSpaReady }");
    expect(code).toContain("await waitForSpaReady(page, logger);");
  });

  it("wires the shared Anthropic client so the cascade can rephrase/replan", () => {
    expect(code).toContain('import { buildAnthropicClient } from "@/lib/llm/anthropic-client"');
    expect(code).toContain("anthropic: buildAnthropicClient(),");
    expect(code).not.toContain("anthropic: null");
  });

  it("accumulates the spliced field names", () => {
    expect(payloadFieldNames).toEqual(new Set(["FirstName", "Email"]));
  });
});

describe("emitBrowserFlowTs — resumeFixture guard (upload vs multipart)", () => {
  const uploadFlow = [{ step: "Upload the resume PDF using the upload control", upload: true }];

  it("wires a Buffer-based resumeFixture when the contract is multipart", () => {
    const { code } = emitBrowserFlowTs({
      siteId: "s",
      pascal: "S",
      baseUrl: "https://x",
      isSubmissionFlow: true,
      flowSteps: uploadFlow,
      hasMultipartStep: true,
    });
    expect(code).toContain("Buffer.from(payload.Resume");
    expect(code).toContain("payload.ResumeFilename");
  });

  it("emits null + TODO (never a Resume field ref) when uploading but not multipart", () => {
    const { code } = emitBrowserFlowTs({
      siteId: "s",
      pascal: "S",
      baseUrl: "https://x",
      isSubmissionFlow: true,
      flowSteps: uploadFlow,
      hasMultipartStep: false,
    });
    expect(code).not.toContain("payload.Resume");
    expect(code).toContain("resumeFixture: null");
    expect(code).toContain("TODO: this flow uploads");
  });
});

describe("emitBrowserFlowTs + emitContractTs — schema/flow anti-drift", () => {
  const flowSteps = [
    "Fill in the First Name field with 'Reginald'",
    `Enter ${RECON_EMAIL_TOKEN} in the Email Address field`,
    "Type '5125551234' into the Mobile Phone field",
    "Enter 'Austin' in the City field",
  ];
  const { code, payloadFieldNames } = emitBrowserFlowTs({
    siteId: "test-site",
    pascal: "TestSite",
    baseUrl: "https://example.com",
    isSubmissionFlow: true,
    flowSteps,
  });
  const contract = emitContractTs({
    ...BASE_OPTS,
    inputBody: { Name: "Alice" },
    payloadFieldNames,
  });

  it("every payload.X the flow references appears as a contract schema key", () => {
    const referenced = [...code.matchAll(/\$\{payload\.([A-Za-z0-9_]+)\}/g)].map((m) => m[1]!);
    expect(referenced.length).toBeGreaterThan(0);
    for (const field of referenced) {
      const decl = field === "Email" ? `${field}: z.email()` : `${field}: z.string()`;
      expect(contract).toContain(decl);
    }
  });
});

describe("emitConfigManifest — config-only plugin emission", () => {
  const manifestStr = emitConfigManifest({
    siteId: "acme-demo",
    displayName: "AcmeDemo",
    baseUrl: "https://apply.acme.example",
    flowSteps: [
      "click the apply button",
      { step: "fill the First Name field with 'Jane'", payloadField: "FirstName" },
      { step: `fill the Email field with ${RECON_EMAIL_TOKEN}`, payloadField: "Email" },
      { step: "click Submit", submitStep: true },
      { step: "upload resume", upload: true, optional: true },
    ],
  });
  const manifest = JSON.parse(manifestStr) as {
    apiVersion: string;
    kind: string;
    spec: {
      request: { properties: Record<string, unknown> };
      flow: { steps: unknown[] };
    };
  };

  it("emits the K8s-style envelope", () => {
    expect(manifest.apiVersion).toBe(CONFIG_PLUGIN_API_VERSION);
    expect(manifest.kind).toBe(CONFIG_PLUGIN_KIND);
  });

  it("rewrites recon splices into {{ .request.X }} templates", () => {
    expect(manifestStr).toContain("{{ .request.FirstName }}");
    expect(manifestStr).toContain("{{ .request.Email }}");
    expect(manifestStr).not.toContain("'Jane'");
    expect(manifestStr).not.toContain(RECON_EMAIL_TOKEN);
  });

  it("promotes every spliced field into the request schema (no drift)", () => {
    expect(Object.keys(manifest.spec.request.properties).sort()).toEqual(["Email", "FirstName"]);
  });

  it("preserves submit and upload/optional flags on object-form steps", () => {
    const objectSteps = manifest.spec.flow.steps.filter(
      (s): s is { step: string; submitStep?: boolean; upload?: boolean; optional?: boolean } =>
        typeof s === "object" && s !== null
    );
    expect(objectSteps.some((s) => s.submitStep === true)).toBe(true);
    expect(objectSteps.some((s) => s.upload === true && s.optional === true)).toBe(true);
  });
});
