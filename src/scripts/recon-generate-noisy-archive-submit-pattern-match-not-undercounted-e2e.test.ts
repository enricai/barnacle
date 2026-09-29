import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Regression for the REST-path noise-isolation defect recon-generate.ts:14108-14128
 * itself documents: extractActionSequence's structural-isolation pass has no
 * "declared, so authoritative" exemption for a submitBodyPattern-only match
 * (only a declared submitEndpointPattern is exempted, via
 * matchesDeclaredSubmitEndpoint) — so a flow that declares ONLY a
 * submitBodyPattern (no submitEndpointPattern) can have every one of its
 * genuine, body-matching submission captures dropped as "structurally
 * isolated" once enough unrelated same-host noise is mixed in, reading as
 * "0 capture(s)" even though the archive genuinely contains several matches.
 * Purely REST/JSON — no GraphQL-shaped capture anywhere — so this exercises
 * extractActionSequence directly, independent of the isGraphQL() branch
 * covered by recon-generate-declared-submit-pattern-real-matches-amid-noise-regression-e2e.test.ts.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.noisy-archive-submit-pattern-fixture.example.com";
const CONFIRMATION_TOKEN = "ORDER-CONFIRM-TOKEN-77";

// Three genuine submissions, each to its own structurally distinct
// (token-disjoint) compound endpoint path, so none of them can "vouch" for
// another via shared path tokens once the structural-isolation pass runs.
const GENUINE_PATHS = ["finalize-checkout", "complete-purchase", "confirm-order"];

function fixtureCaptures(): Capture[] {
  const genuine = GENUINE_PATHS.map((path, index) =>
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/orders/${path}/`,
      requestPostData: JSON.stringify({ confirmationToken: `${CONFIRMATION_TOKEN}-${index}` }),
      responseBody: { ok: true },
      timestamp: `2026-05-01T00:00:0${index}Z`,
    })
  );
  // A large volume of structurally-similar-looking, same-host noise: each
  // has its own compound path (so it isn't dropped by the pool-of-3+ guard
  // for lacking a compound segment) and none carries the declared body
  // pattern, mirroring the real archive's "genuine matches buried in a much
  // larger pile of same-shaped noise" complaint.
  const noise: Capture[] = Array.from({ length: 40 }, (_unused, index) =>
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/marketing/promotions-widget-${index}/`,
      requestPostData: JSON.stringify({ page: index }),
      responseBody: { items: [] },
      timestamp: `2026-05-01T00:01:${String(index).padStart(2, "0")}Z`,
    })
  );
  return [...genuine, ...noise];
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

describe("recon-generate CLI — declared submitBodyPattern-only matches survive noise on the REST path", () => {
  it("reports the real genuine capture count, not a spurious 0-capture(s) disagreement", () => {
    if (!existsSync(TSX_BIN)) {
      throw new Error("tsx not installed — cannot run the real CLI");
    }

    workDir = mkdtempSync(join(tmpdir(), "barnacle-noisy-archive-submit-pattern-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `noisy-archive-submit-pattern-e2e-test${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "submit order", submitStep: true }],
        submitBodyPattern: "confirmationToken",
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
    // The genuine, declared-pattern-matching submission count must never
    // read as "(0 capture(s))" when real matches exist in the archive.
    expect(combinedOutput).not.toContain(
      "declared submitEndpointPattern/submitBodyPattern (0 capture(s))"
    );

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contract).toContain("orders");
    expect(contract).toContain("confirmationToken");
  }, 60_000);
});
