import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildConfigPlugin } from "@/plugins/config-plugin";
import type { ReconVocabulary } from "@/recon/vocabulary";
import {
  emitBrowserFlowTs,
  emitConfigManifest,
  emitContractTs,
  main,
  resolveMaxAttempts,
} from "@/scripts/recon-generate";
import {
  buildCapture,
  buildWizardCheckoutCaptures,
} from "@/scripts/recon-generate-multicall-fixture";
import { readDeclaredMaxAttempts } from "@/scripts/recon-shared";

/** Concatenation trick so Biome's noTemplateCurlyInString rule doesn't flag the literal. */
const RECON_PASSWORD_TOKEN = `$${"{RECON_PASSWORD}"}`;

const VOCABULARY: ReconVocabulary = {
  subject: /\b(the\s+)?(test\s+)?(candidate|applicant)'?s\b/i,
  exclusions: [],
  table: [[/\bphone number\b/i, "Phone"]],
};

function browserFlow(flowSteps: string[]): ReturnType<typeof emitBrowserFlowTs> {
  return emitBrowserFlowTs({
    siteId: "test-site",
    pascal: "TestSite",
    baseUrl: "https://example.com",
    isSubmissionFlow: true,
    flowSteps,
    vocabulary: VOCABULARY,
  });
}

const CONTRACT_BASE = {
  siteId: "test-site",
  pascal: "TestSite",
  baseUrl: "https://api.example.com",
  baseHeaders: {},
  minTime: 100,
  safeRps: 10,
  responseBody: {},
  gql: false,
  gqlQuery: null,
  endpointPath: "/apply",
  auxFiles: [],
  multiStepBody: undefined,
  isSubmissionFlow: true,
  inputBody: { vendorKey: "x" },
  payloadFieldNames: new Set(["FirstName"]),
};

describe("account-creation flows emit meta.maxAttempts: 1", () => {
  const withPassword = browserFlow([
    `Fill in the Password field (data-automation-id='password') with '${RECON_PASSWORD_TOKEN}'`,
  ]);
  const withoutPassword = browserFlow(["Click the Apply button"]);

  it("carries the password signal out of emitBrowserFlowTs only when the token is present", () => {
    expect(withPassword.usesThrowawayPassword).toBe(true);
    expect(withoutPassword.usesThrowawayPassword).toBe(false);
  });

  it("emits maxAttempts: 1 for the RECON_PASSWORD flow", () => {
    const source = emitContractTs({
      ...CONTRACT_BASE,
      omitExecuteHttp: true,
      createsAccount: withPassword.usesThrowawayPassword,
    });
    expect(source).toMatch(/maxAttempts: 1,/);
  });

  it("emits no maxAttempts for the same flow without the token", () => {
    const source = emitContractTs({
      ...CONTRACT_BASE,
      omitExecuteHttp: true,
      createsAccount: withoutPassword.usesThrowawayPassword,
    });
    expect(source).not.toContain("maxAttempts");
  });
});

describe("execute() context parameter reflects usage", () => {
  it("omits the context parameter and the hot-path-fallback comment for browser-only reading payload.ClickUrl", () => {
    const source = emitContractTs({ ...CONTRACT_BASE, omitExecuteHttp: true });
    expect(source).not.toContain("context: SitePluginContext");
    expect(source).not.toMatch(/import type \{[^}]*SitePluginContext/);
    expect(source).not.toContain("invoked only when hot path fails");
  });

  it("emits the hot-path-fallback comment when executeHttp exists", () => {
    const source = emitContractTs({ ...CONTRACT_BASE, omitExecuteHttp: false });
    expect(source).toContain("invoked only when hot path fails");
    expect(source).toMatch(/[^_]context: SitePluginContext/);
  });
});

describe("emitConfigManifest account-creation maxAttempts", () => {
  const emit = (flowSteps: string[]): { spec: Record<string, unknown> } =>
    JSON.parse(
      emitConfigManifest({ siteId: "test-site", baseUrl: "https://example.org", flowSteps })
    );

  it("emits spec.maxAttempts: 1 for a RECON_PASSWORD flow", () => {
    const manifest = emit([
      `Fill in the Password field with '${RECON_PASSWORD_TOKEN}'`,
      "Click the Sign up button",
    ]);
    expect(manifest.spec.maxAttempts).toBe(1);
  });

  it("omits maxAttempts without the token", () => {
    expect(emit(["Click the Apply button"]).spec).not.toHaveProperty("maxAttempts");
  });

  it("loads through buildConfigPlugin and forwards maxAttempts", async () => {
    const manifest = emit([
      `Fill in the Password field with '${RECON_PASSWORD_TOKEN}'`,
      "Click the Sign up button",
    ]);
    const plugin = await buildConfigPlugin(manifest);
    expect(plugin.meta.maxAttempts).toBe(1);
  });
});

describe("contract derives account creation from its own flowSteps", () => {
  it("emits maxAttempts: 1 when flowSteps splice the password token and no createsAccount flag is passed", () => {
    const source = emitContractTs({
      ...CONTRACT_BASE,
      omitExecuteHttp: true,
      flowSteps: [`Fill in the Password field with '${RECON_PASSWORD_TOKEN}'`],
    });
    expect(source).toMatch(/maxAttempts: 1,/);
  });
});

describe("resolveMaxAttempts", () => {
  it("forces 1 for an irreversibility signal, else the declaration, else null", () => {
    expect(resolveMaxAttempts({ createsAccount: true, declared: 5 })).toBe(1);
    expect(resolveMaxAttempts({ declared: 4 })).toBe(4);
    expect(resolveMaxAttempts({})).toBeNull();
  });
});

describe("readDeclaredMaxAttempts", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });
  const read = (flow: unknown): number | null => {
    dir = mkdtempSync(join(tmpdir(), "barnacle-declared-max-"));
    const file = join(dir, "recon-flow.json");
    writeFileSync(file, JSON.stringify(flow));
    return readDeclaredMaxAttempts(file);
  };

  it("reads maxAttempts: N and irreversible: true; ignores invalid values", () => {
    expect(read({ steps: [], maxAttempts: 3 })).toBe(3);
    expect(read({ steps: [], irreversible: true })).toBe(1);
    expect(read({ steps: [], irreversible: true, maxAttempts: 3 })).toBe(1);
    expect(read({ steps: [], maxAttempts: 0 })).toBeNull();
    expect(read({ steps: [], maxAttempts: 2.5 })).toBeNull();
    expect(read({ steps: [] })).toBeNull();
    expect(read([])).toBeNull();
  });
});

describe("recon-generate end to end — generated maxAttempts", () => {
  const REPO_ROOT = join(__dirname, "..", "..");
  const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");
  let workDir: string | null = null;
  let siteOutDir: string | null = null;
  afterEach(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
    if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
    workDir = null;
    siteOutDir = null;
  });

  /** Runs main() in-process over one captured request; returns the emitted .ts and manifest. */
  async function generate(
    flow: Record<string, unknown>,
    method: string,
    replayable = false
  ): Promise<{ contract: string; manifest: { spec: Record<string, unknown> } }> {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-max-attempts-"));
    const runRoot = join(workDir, "run");
    const capturesDir = join(runRoot, "graphql");
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
    const captures = replayable
      ? buildWizardCheckoutCaptures()
      : [
          buildCapture({
            url: "https://shop.example.com/order.json",
            requestPostData: method === "GET" ? null : JSON.stringify({ item: "widget" }),
            responseBody: { ok: true },
            timestamp: "2024-02-01T00:00:00Z",
            method,
          }),
        ];
    captures.forEach((capture, index) => {
      writeFileSync(
        join(capturesDir, `${String(index).padStart(3, "0")}-checkout-action.json`),
        JSON.stringify(capture)
      );
    });
    const siteId = `max-attempts-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(join(siteOutDir, "recon-flow.json"), JSON.stringify(flow));
    const savedArgv = process.argv;
    try {
      for (const emit of ["ts", "config"]) {
        process.argv = [
          savedArgv[0] ?? "node",
          GENERATE_SCRIPT,
          "--site-id",
          siteId,
          "--run-dir",
          runRoot,
          "--emit",
          emit,
          "--force",
        ];
        await main();
      }
    } finally {
      process.argv = savedArgv;
    }
    return {
      contract: readFileSync(join(siteOutDir, "contract.ts"), "utf8"),
      manifest: JSON.parse(readFileSync(join(siteOutDir, `${siteId}.plugin.json`), "utf8")),
    };
  }

  const REPORT_FLOW = {
    steps: [{ step: "open the order page" }, { step: "place the order", submitStep: true }],
    browserFlowOnly: true,
    applicantContract: false,
    submitEndpointPattern: "/order.json",
    requireSubmitEndpointMatch: true,
  };

  it("yields maxAttempts: 1 in both outputs for a browser-flow-only non-GET submit", async () => {
    const { contract, manifest } = await generate(REPORT_FLOW, "POST");
    expect(contract).toMatch(/maxAttempts: 1,/);
    expect(manifest.spec.maxAttempts).toBe(1);
  }, 60_000);

  it("honours irreversible: true and maxAttempts: N declarations in both outputs", async () => {
    const irreversible = await generate(
      {
        ...REPORT_FLOW,
        browserFlowOnly: false,
        submitEndpointPattern: "/checkout",
        irreversible: true,
      },
      "POST",
      true
    );
    expect(irreversible.contract).toMatch(/maxAttempts: 1,/);
    expect(irreversible.manifest.spec.maxAttempts).toBe(1);
    const declared = await generate(
      {
        ...REPORT_FLOW,
        browserFlowOnly: false,
        submitEndpointPattern: "/checkout",
        maxAttempts: 3,
      },
      "POST",
      true
    );
    expect(declared.contract).toMatch(/maxAttempts: 3,/);
    expect(declared.manifest.spec.maxAttempts).toBe(3);
  }, 60_000);

  it("emits none for a read-only GET flow", async () => {
    const { contract, manifest } = await generate(
      { steps: [{ step: "open the order page" }], browserFlowOnly: true },
      "GET"
    );
    expect(contract).not.toMatch(/maxAttempts: \d/);
    expect(manifest.spec).not.toHaveProperty("maxAttempts");
  }, 60_000);

  it("emits none for a non-browser-only flow without a declaration", async () => {
    const { contract, manifest } = await generate(
      { ...REPORT_FLOW, browserFlowOnly: false, submitEndpointPattern: "/checkout" },
      "POST",
      true
    );
    expect(contract).not.toMatch(/maxAttempts: \d/);
    expect(manifest.spec).not.toHaveProperty("maxAttempts");
  }, 60_000);
});
