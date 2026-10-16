import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contractUsesApplicantContactSchema } from "@/scripts/recon-generate";
import { buildWizardCheckoutCaptures } from "@/scripts/recon-generate-multicall-fixture";
import { readBrowserFlowOnly } from "@/scripts/recon-shared";

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

/** Runs the real generator CLI over the wizard-checkout captures with the given
 * raw recon-flow.json contents. */
function runGenerate(flowContents: string): ReturnType<typeof spawnSync> {
  workDir = mkdtempSync(join(tmpdir(), "barnacle-bfo-opt-in-"));
  const runRoot = join(workDir, "run");
  const capturesDir = join(runRoot, "graphql");
  mkdirSync(capturesDir, { recursive: true });
  mkdirSync(join(runRoot, "replays"), { recursive: true });
  mkdirSync(join(runRoot, "aux"), { recursive: true });
  writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
  buildWizardCheckoutCaptures().forEach((capture, index) => {
    writeFileSync(
      join(capturesDir, `${String(index).padStart(3, "0")}-checkout-action.json`),
      JSON.stringify(capture)
    );
  });
  const siteId = `bfo-opt-in-test-${process.pid}`;
  siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(join(siteOutDir, "recon-flow.json"), flowContents);
  return spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
}

/** Runs the generator and returns every emitted file keyed by name. */
function generate(flow: Record<string, unknown>): Record<string, string> {
  const result = runGenerate(JSON.stringify(flow));
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  const outDir = siteOutDir ?? "";
  return Object.fromEntries(
    readdirSync(outDir)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => [name, readFileSync(join(outDir, name), "utf8")])
  );
}

const FLOW = {
  steps: [{ step: "open the checkout page" }, { step: "confirm the order", submitStep: true }],
  submitEndpointPattern: "/checkout",
};

describe("browserFlowOnly opt-in — decision and readers", () => {
  it("follows isSubmissionFlow && browserFlowOnly regardless of inputBody", () => {
    for (const inputBody of [undefined, null, {}, { vendorKey: "x" }]) {
      expect(
        contractUsesApplicantContactSchema({
          inputBody,
          isSubmissionFlow: true,
          browserFlowOnly: true,
        })
      ).toBe(true);
      expect(
        contractUsesApplicantContactSchema({
          inputBody,
          isSubmissionFlow: false,
          browserFlowOnly: true,
        })
      ).toBe(false);
    }
    expect(
      contractUsesApplicantContactSchema({
        inputBody: { vendorKey: "x" },
        isSubmissionFlow: true,
        browserFlowOnly: false,
      })
    ).toBe(false);
  });

  it("the string parser and the file reader agree on the opt-in", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-bfo-reader-"));
    const cases: Array<[string, boolean]> = [
      ['{"steps":[],"browserFlowOnly":true}', true],
      ['{"steps":[],"browserFlowOnly":"true"}', false],
      ['{"steps":[],"browserFlowOnly":false}', false],
      ['{"steps":[]}', false],
      ["[]", false],
      ["null", false],
    ];
    cases.forEach(([contents, expected], index) => {
      const file = join(workDir as string, `flow-${index}.json`);
      writeFileSync(file, contents);
      expect(readBrowserFlowOnly(file), contents).toBe(expected);
    });
    expect(() => readBrowserFlowOnly(join(workDir as string, "missing.json"))).toThrow();
    const malformed = join(workDir, "malformed.json");
    writeFileSync(malformed, "not json");
    expect(() => readBrowserFlowOnly(malformed)).toThrow();
  });
});

describe("recon-generate CLI — browserFlowOnly flow-file opt-in", () => {
  it("emits ApplicantContactSchema, enters on payload.ClickUrl, and omits executeHttp", () => {
    const files = generate({ ...FLOW, browserFlowOnly: true });
    const contract = files["contract.ts"] ?? "";
    expect(contract).toContain("ApplicantContactSchema.extend(");
    expect(contract).toContain("ClickUrl: z.string().min(1)");
    expect(contract).toContain("Answers:");
    expect(contract).toContain("import { ApplicantContactSchema }");
    expect(contract).toMatch(/BrowserFlow\(session\.stagehand, payload\.ClickUrl,/);
    expect(contract).not.toContain("async executeHttp(");
    expect(contract).not.toContain("payload.query");
    expect(Object.keys(files).filter((name) => name.endsWith(".http.ts"))).toEqual([]);
  }, 60_000);

  it("fails nonzero on a malformed flow file instead of silently opting out", () => {
    const result = runGenerate("{ not json");
    expect(result.status).not.toBe(0);
  }, 60_000);

  it("keeps existing behaviour without the flag", () => {
    const contract = generate(FLOW)["contract.ts"] ?? "";
    expect(contract).toContain("async executeHttp(");
  }, 60_000);
});
