import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildMultiEndpointSubmissionActionSteps } from "@/scripts/recon-generate-multiendpoint-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Locks in the exact reported scenario at the CLI boundary: a landing/entry
 * GET capture with a query-string job identifier on one host, followed by
 * the real create -> per-section POST -> PUT validate sequence captured
 * entirely on a SECOND, different host — with no submitEndpointPattern and
 * no submit-manifest.json declared, the natural shape produced by an
 * unassisted recon walk. Distinct from
 * recon-generate-multiendpoint-e2e.test.ts's cross-host case, which still
 * declares a submitEndpointPattern; this test covers the unassisted,
 * pattern-free path the report's exact scenario takes. Verified (not
 * asserted in CI) to fail against the pre-fix recon-generate.ts, where
 * extractActionSequence filtered action captures to the landing capture's
 * host and so silently dropped every cross-host section call.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const LANDING_URL = "https://portal.example.com/apply?jobId=12345";

function landingCapture(): Capture {
  return {
    timestamp: "2023-12-31T23:59:59Z",
    phase: "home",
    method: "GET",
    url: LANDING_URL,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: { "content-type": "text/html" },
    responseBody: null,
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate cross-host CLI e2e: unassisted walk must never fabricate the {query} stub", () => {
  it("emits the real per-section call sequence for a cross-host authenticated submission with no submitEndpointPattern or submit-manifest declared", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-recon-crosshost-submission-e2e-"));
    const runRoot = join(workDir, "run");
    const capturesDir = join(runRoot, "graphql");
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));

    const landing = landingCapture();
    const actionCaptures = buildMultiEndpointSubmissionActionSteps().map((s) => s.capture);
    const allCaptures = [landing, ...actionCaptures];
    allCaptures.forEach((capture, index) => {
      const filename = `${String(index).padStart(3, "0")}-crosshost-action.json`;
      writeFileSync(join(capturesDir, filename), JSON.stringify(capture));
    });

    const siteId = `recon-crosshost-submission-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);

    // No submitEndpointPattern, no submit-manifest.json — the shape an
    // unassisted recon walk naturally produces.
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "fill out applicant, address, contact, employment, and attachment sections" },
          { step: "submit address section", submitStep: true },
        ],
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    const landingPathname = new URL(LANDING_URL).pathname;

    // The doc's headline defect: a fabricated `{ query: payload.query }`
    // POST aimed at the GET-captured landing page must never appear.
    const hasBogusQueryBody = contract.includes("query: payload.query");
    const postsToLandingPage = contract.includes(landingPathname);
    expect(hasBogusQueryBody && postsToLandingPage).toBe(false);

    // One of the two report-sanctioned outcomes: either the real per-section
    // call sequence is present, or executeHttp is omitted entirely with a
    // bodySchema built on ApplicantContactSchema.extend.
    const hasExecuteHttp = contract.includes("executeHttp(");
    const hasFullMultiCallSequence =
      contract.includes("/applications") &&
      contract.includes("/applicant") &&
      contract.includes("/address") &&
      contract.includes("/contact") &&
      contract.includes("/employment") &&
      contract.includes("/attachments") &&
      contract.includes("/validate");
    const hasApplicantContactExtend =
      !hasExecuteHttp && contract.includes("ApplicantContactSchema.extend");
    expect(hasFullMultiCallSequence || hasApplicantContactExtend).toBe(true);
  }, 30_000);
});
