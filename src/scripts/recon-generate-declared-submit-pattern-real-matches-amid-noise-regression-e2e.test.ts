import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Regression for the cascade where a wrongly-true isGraphQL() classification
 * (driven by an unrelated third-party host's GraphQL-shaped captures) forces
 * the unfiltered heuristic baseline through extractGraphQLActionSequence
 * instead of extractActionSequence, so a genuine own-backend REST submission
 * capture that matches the flow's declared submitEndpointPattern reads as
 * "0 capture(s)" against that GraphQL-shaped baseline and logs a spurious
 * disagreement. The archive here mixes real own-backend REST captures
 * (matching the declared pattern) with third-party GraphQL-shaped noise on a
 * different host, mirroring
 * recon-generate-1-12-50-payload-field-body-schema-structural-parity-tsc-e2e.test.ts's
 * requireSubmitEndpointMatch/submitEndpointPattern recon-flow.json shape.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.declared-submit-pattern-noise-fixture.example.com";
const THIRD_PARTY_HOST = "sdk.declared-submit-pattern-noise-decoy.example.net";
const LIST_URL = `https://${OWN_BACKEND_HOST}/catalog/search/`;
const SUBMIT_URL = `https://${OWN_BACKEND_HOST}/catalog/submit/`;

const SUBMIT_FIELD_VALUE = "ORDER-CONFIRMATION-TOKEN-01";

function fixtureCaptures(): Capture[] {
  // An own-backend REST POST carrying a token that the submit below re-sends
  // verbatim — the two-step action sequence that makes this a submission
  // flow, not a single-endpoint read.
  const listPage = buildCapture({
    url: LIST_URL,
    requestPostData: JSON.stringify({ page: SUBMIT_FIELD_VALUE }),
    responseBody: { results: [{ itemId: "item-a" }] },
    timestamp: "2026-05-01T00:00:00Z",
  });
  // The real submission: an own-backend REST POST matching the declared
  // submitEndpointPattern below.
  const submit = buildCapture({
    url: SUBMIT_URL,
    requestPostData: JSON.stringify({ itemId: "item-a", confirmationToken: SUBMIT_FIELD_VALUE }),
    responseBody: { ok: true },
    timestamp: "2026-05-01T00:00:01Z",
  });
  // Third-party GraphQL-shaped noise: a different host entirely, so it
  // must never make isGraphQL() (host-scoped) report true for this archive.
  const thirdPartyGraphQLNoise: Capture[] = Array.from({ length: 10 }, (_unused, index) => ({
    timestamp: `2026-05-01T00:00:${String(2 + index).padStart(2, "0")}Z`,
    phase: "action",
    method: "POST",
    url: `https://${THIRD_PARTY_HOST}/graphql`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: "{}",
    responseHeaders: { "content-type": "application/json" },
    responseBody: { data: { tracking: { pixel: `noise-${index}` } } },
    operationName: "TrackingPixel",
    query: "query TrackingPixel { tracking { pixel } }",
    variables: null,
    decodedParams: null,
  }));
  return [listPage, submit, ...thirdPartyGraphQLNoise];
}

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

describe("recon-generate CLI — declared submitEndpointPattern finds real matches amid third-party GraphQL noise", () => {
  it("uses the real own-backend submission capture instead of reporting a spurious 0-capture(s) disagreement", () => {
    if (!existsSync(TSX_BIN)) {
      throw new Error("tsx not installed — cannot run the real CLI");
    }

    workDir = mkdtempSync(
      join(tmpdir(), "barnacle-declared-submit-pattern-real-matches-amid-noise-")
    );
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `declared-submit-pattern-noise-e2e-test${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "browse catalog search" }, { step: "submit order", submitStep: true }],
        submitEndpointPattern: "catalog/submit",
        requireSubmitEndpointMatch: true,
        ownBackendHostnames: [OWN_BACKEND_HOST],
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    expect(result.status, combinedOutput).toBe(0);
    expect(combinedOutput).not.toContain("(0 capture(s)) disagrees with the unfiltered heuristic");

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contract).toContain("catalog/submit");
    expect(contract).toContain("confirmationToken");
  }, 60_000);
});
