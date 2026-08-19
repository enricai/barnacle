import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildMultiEndpointSubmissionActionSteps } from "@/scripts/recon-generate-multiendpoint-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins the report's headline defect at the CLI boundary the operator actually
 * runs: `recon:generate` must not collapse a genuine multi-endpoint
 * authenticated submission into a fabricated single `{ query: payload.query }`
 * POST aimed at a GET-navigation landing-page URL. The run dir carries a real
 * landing-page GET capture plus the fixture's 8-call section-save sequence,
 * and the site's recon-flow.json declares a submitEndpointPattern scoped to
 * only one section — the same real-world shape that under-selects the
 * heuristic action sequence in recon-generate.ts's manifest-precedence path
 * (recon-generate-manifest-undercoverage.test.ts), reproduced here via the
 * flow-declared pattern instead of submit-manifest.json, end to end through
 * the real CLI.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const LANDING_URL = "https://api.example.com/job/12345/apply";

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

describe("recon-generate multiendpoint CLI e2e: never fabricate a {query} POST to a GET-captured page", () => {
  it("routes a real multi-endpoint submission through a working plugin instead of the bogus single-call stub", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-recon-multiendpoint-e2e-"));
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
      const filename = `${String(index).padStart(3, "0")}-multiendpoint-action.json`;
      writeFileSync(join(capturesDir, filename), JSON.stringify(capture));
    });

    const siteId = `recon-multiendpoint-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);

    // A submitEndpointPattern scoped to a single section — the natural way to
    // declare "the button that finishes the wizard" — the same real-world
    // config shape the recon report's site uses, matching only one of the
    // fixture's genuine section-save endpoints.
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "fill out applicant, address, contact, employment, and attachment sections" },
          { step: "submit address section", submitStep: true },
        ],
        submitEndpointPattern: "/address$",
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

    // The headline defect: a fabricated `{ query: payload.query }` POST aimed
    // at the GET-captured landing page must never appear together.
    const hasBogusQueryBody = contract.includes("query: payload.query");
    const postsToLandingPage = contract.includes(landingPathname);
    expect(hasBogusQueryBody && postsToLandingPage).toBe(false);

    // One of the two report-sanctioned outcomes: either the real multi-call
    // sequence (every fixture section path present), or no executeHttp at all.
    const hasExecuteHttp = contract.includes("executeHttp(");
    const hasFullMultiCallSequence =
      contract.includes("/applications") &&
      contract.includes("/applicant") &&
      contract.includes("/address") &&
      contract.includes("/contact") &&
      contract.includes("/employment") &&
      contract.includes("/attachments") &&
      contract.includes("/validate");
    expect(hasFullMultiCallSequence || !hasExecuteHttp).toBe(true);
  }, 30_000);

  it("emits the real multi-call sequence when every action capture lives on a different host than the landing page (account-creation redirect / tenant API subdomain)", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-recon-multiendpoint-crosshost-e2e-"));
    const runRoot = join(workDir, "run");
    const capturesDir = join(runRoot, "graphql");
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));

    // The landing/entry page is on the job-board host; every real action
    // capture (the fixture's create -> per-section -> validate sequence)
    // lives on a distinct tenant API host, matching how an authenticated
    // submission routinely bounces to a different host mid-flow.
    const crossHostLandingUrl = "https://jobs.tenant.example.com/job/12345/apply";
    const landing: Capture = { ...landingCapture(), url: crossHostLandingUrl };
    const actionCaptures = buildMultiEndpointSubmissionActionSteps().map((s) => s.capture);
    const allCaptures = [landing, ...actionCaptures];
    allCaptures.forEach((capture, index) => {
      const filename = `${String(index).padStart(3, "0")}-multiendpoint-action.json`;
      writeFileSync(join(capturesDir, filename), JSON.stringify(capture));
    });

    const siteId = `recon-multiendpoint-crosshost-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "fill out applicant, address, contact, employment, and attachment sections" },
          { step: "submit address section", submitStep: true },
        ],
        submitEndpointPattern: "/address$",
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // The headline defect: never fall back to the fabricated single-call
    // stub just because the real captures live off the landing page's host.
    expect(contract).not.toContain("query: payload.query");

    // The real multi-call sequence must be emitted with the actual captured
    // tenant-API absolute URLs — never dropped by an exact-host filter.
    expect(contract).toContain("executeHttp(");
    expect(contract).toContain("https://api.example.com/applications");
    expect(contract).toContain("https://api.example.com/applicant");
    expect(contract).toContain("https://api.example.com/address");
    expect(contract).toContain("https://api.example.com/contact");
    expect(contract).toContain("https://api.example.com/employment");
    expect(contract).toContain("https://api.example.com/attachments");
    expect(contract).toContain("https://api.example.com/validate");
  }, 30_000);
});
