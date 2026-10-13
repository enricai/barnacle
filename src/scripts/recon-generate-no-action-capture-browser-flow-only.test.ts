import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emitContractTs } from "@/scripts/recon-generate";
import { buildWizardCheckoutCaptures } from "@/scripts/recon-generate-multicall-fixture";

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

interface GenerateOptions {
  steps: Array<string | Record<string, unknown>>;
  submitEndpointPattern: string;
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

/** Runs the real generator CLI over the same-host wizard-checkout captures with a
 * declared submit pattern, returning the emitted contract.ts source. */
function generateContract({ steps, submitEndpointPattern }: GenerateOptions): string {
  workDir = mkdtempSync(join(tmpdir(), "barnacle-no-action-capture-"));
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

  const siteId = `no-action-capture-test-${process.pid}`;
  siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({ steps, submitEndpointPattern })
  );

  const result = spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return readFileSync(join(siteOutDir, "contract.ts"), "utf8");
}

describe("recon-generate CLI — declared submit pattern matching no capture", () => {
  it("ships browser-flow-only with no executeHttp and no {query} field for a multi-step flow", () => {
    const contract = generateContract({
      steps: [
        { step: "open the checkout page" },
        { step: "continue to the next page" },
        { step: "confirm the order", submitStep: true },
      ],
      submitEndpointPattern: "/submitApplication",
    });

    expect(contract).not.toContain("async executeHttp(");
    expect(contract).not.toContain("payload.query");
    expect(contract).not.toContain("query: z.string().min(1)");
  }, 60_000);

  it("selects ApplicantContactSchema when applicant-named payload fields are spliced into the steps", () => {
    const contract = generateContract({
      steps: [
        { step: "open the checkout page" },
        { step: "type the first name", payloadField: "FirstName" },
        { step: "type the last name", payloadField: "LastName" },
        { step: "confirm the order", submitStep: true },
      ],
      submitEndpointPattern: "/submitApplication",
    });

    expect(contract).not.toContain("async executeHttp(");
    expect(contract).not.toContain("query: z.string().min(1)");
    expect(contract).toContain("ApplicantContactSchema");
  }, 60_000);
});

describe("emitContractTs — single-action search flow", () => {
  it("still emits the {query} single-endpoint output unchanged", () => {
    const source = emitContractTs({
      siteId: "test-site",
      pascal: "TestSite",
      baseUrl: "https://api.example.com",
      baseHeaders: { "Content-Type": "application/json" },
      minTime: 100,
      safeRps: 10,
      responseBody: { id: "abc" },
      gql: false,
      gqlQuery: null,
      endpointPath: "/search",
      auxFiles: [],
    });

    expect(source).toContain("async executeHttp(");
    expect(source).toContain("query: payload.query");
    expect(source).toContain("z.object({\n  query: z.string().min(1),\n})");
  });
});
