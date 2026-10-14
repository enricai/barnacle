import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  buildCapture,
  buildWizardCheckoutCaptures,
} from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * End-to-end guard for a multi-step flow whose declared submitEndpointPattern
 * selects none of the captures: it must generate as a browser-flow-only
 * submission flow (applicant schema, no executeHttp), not the single-endpoint
 * `{query}` branch. A single-step search flow must keep the `{query}` output.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

function writeRunDir(root: string, captures: Capture[]): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));
  captures.forEach((capture, index) => {
    writeFileSync(
      join(root, "graphql", `${String(index).padStart(3, "0")}-capture.json`),
      JSON.stringify(capture)
    );
  });
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

function generate(
  captures: Capture[],
  flow: Record<string, unknown>,
  emit: "ts" | "config" = "ts"
): { output: string; contract: string } {
  workDir = mkdtempSync(join(tmpdir(), "barnacle-no-replayable-action-e2e-"));
  const runRoot = join(workDir, "run");
  writeRunDir(runRoot, captures);

  const siteId = `no-replayable-action-e2e-test-${process.pid}`;
  siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(join(siteOutDir, "recon-flow.json"), JSON.stringify(flow));

  const result = spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", emit, "--force"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
  const output = `${result.stdout}\n${result.stderr}`;
  expect(result.status, output).toBe(0);
  return {
    output,
    contract: readFileSync(
      join(siteOutDir, emit === "ts" ? "contract.ts" : `${siteId}.plugin.json`),
      "utf8"
    ),
  };
}

describe("recon-generate CLI — declared submitEndpointPattern selecting zero captures", () => {
  it("generates a browser-flow-only submission flow with ApplicantContactSchema for a multi-step flow", () => {
    const { output, contract } = generate(buildWizardCheckoutCaptures(), {
      steps: [
        { step: "open the loan application form" },
        { step: "enter first name", payloadField: "FirstName" },
        { step: "enter last name", payloadField: "LastName" },
        { step: "submit the loan application", submitStep: true },
      ],
      submitEndpointPattern: "/submitApplication",
    });

    expect(contract).not.toContain("async executeHttp(");
    expect(contract).not.toContain("httpClient");
    expect(contract).not.toContain("Bottleneck");
    expect(contract).not.toContain("payload.query");
    expect(contract).not.toContain("query: z.string().min(1)");
    expect(contract).toContain("ApplicantContactSchema.extend");

    expect(output).toContain("submission flow");
    expect(output).toContain("browser-flow-only");
    expect(output).toContain("no replayable action sequence");
    expect(output).not.toContain("cross-domain hop");

    expect(output).toContain("using declared submitEndpointPattern");
    expect(output).not.toContain("ignoring submitEndpointPattern");
    expect(output).not.toContain("as an undercount");
  }, 30_000);

  it("emits a config manifest with no httpModule and no query property for the same flow", () => {
    const { contract } = generate(
      buildWizardCheckoutCaptures(),
      {
        steps: [
          { step: "open the loan application form" },
          { step: "enter first name", payloadField: "FirstName" },
          { step: "enter last name", payloadField: "LastName" },
          { step: "submit the loan application", submitStep: true },
        ],
        submitEndpointPattern: "/submitApplication",
      },
      "config"
    );

    const manifest = JSON.parse(contract);
    expect(manifest.spec.httpModule).toBeUndefined();
    const properties = Object.keys(manifest.spec.request?.properties ?? {});
    expect(properties).toEqual(expect.arrayContaining(["FirstName", "LastName"]));
    expect(properties).not.toContain("query");
  }, 30_000);

  it("still emits the {query} executeHttp output for a single-step search flow", () => {
    const { output, contract } = generate(
      [
        buildCapture({
          url: "https://api.example-store.test/catalog/search",
          requestPostData: JSON.stringify({ query: "lamp" }),
          responseBody: { results: [{ sku: "a1", title: "Desk lamp" }] },
          timestamp: "2024-02-01T00:00:00Z",
        }),
      ],
      { steps: [{ step: "search the catalog" }] }
    );

    expect(contract).toContain("async executeHttp(");
    expect(contract).toContain("query: payload.query");
    expect(contract).not.toContain("ApplicantContactSchema");
    expect(output).not.toContain("browser-flow-only");
  }, 30_000);
});
