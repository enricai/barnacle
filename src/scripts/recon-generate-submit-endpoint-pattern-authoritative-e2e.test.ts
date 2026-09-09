import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins the report's second root cause at the CLI boundary: a flow that
 * declares `submitEndpointPattern` with `requireSubmitEndpointMatch: true`
 * must have that declaration honored as the submission target even when the
 * same own-backend host also carries a much larger unfiltered heuristic
 * sequence of non-matching POSTs (dozens of independent wizard-section
 * saves). Every capture here lives on the SAME own-backend host, so this
 * isolates the pattern-precedence defect from the host-provenance defect
 * covered by recon-generate-thirdparty-telemetry-action-sequence-host-provenance-e2e.test.ts.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.own-backend-pattern-fixture.example.com";
const DECOY_SECTION_COUNT = 24;

function restCapture(overrides: {
  phase: string;
  url: string;
  requestPostData: string;
  responseBody: unknown;
}): Capture {
  return {
    timestamp: "2026-08-18T10:23:03.000Z",
    phase: overrides.phase,
    method: "POST",
    url: overrides.url,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: overrides.requestPostData,
    responseHeaders: {},
    responseBody: overrides.responseBody,
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

/** The two captures the declared pattern matches — the real finish-the-wizard calls. */
function patternMatchedCaptures(): Capture[] {
  return [
    restCapture({
      phase: "wizard-save-final",
      url: `https://${OWN_BACKEND_HOST}/api/wizard/save-final`,
      requestPostData: JSON.stringify({ step: "final" }),
      responseBody: { saved: true },
    }),
    restCapture({
      phase: "wizard-submit-final",
      url: `https://${OWN_BACKEND_HOST}/api/wizard/submit-final`,
      requestPostData: JSON.stringify({ confirm: true }),
      responseBody: { submitted: true },
    }),
  ];
}

/**
 * Dozens of own-backend-host POSTs the pattern does NOT match — independent
 * per-section saves that legitimately outnumber the pattern match even
 * though they share the same host, so host-provenance filtering alone
 * cannot separate them from the real submission.
 */
function decoySectionCaptures(): Capture[] {
  return Array.from({ length: DECOY_SECTION_COUNT }, (_, i) =>
    restCapture({
      phase: "home",
      url: `https://${OWN_BACKEND_HOST}/api/wizard/section-${i}`,
      requestPostData: JSON.stringify({ section: i }),
      responseBody: { saved: true },
    })
  );
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

describe("recon-generate CLI — declared submitEndpointPattern with requireSubmitEndpointMatch is authoritative", () => {
  it("uses the pattern-matched captures as the submission target and warns instead of discarding the pattern", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-submit-endpoint-pattern-authoritative-e2e-"));
    const runRoot = join(workDir, "run");
    // Decoys written first so a chronological/first-capture fallback would
    // pick a decoy, not the pattern match, if the pattern were discarded.
    writeRunDir(runRoot, [...decoySectionCaptures(), ...patternMatchedCaptures()]);

    const siteId = `submit-endpoint-pattern-authoritative-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "fill out every wizard section" },
          { step: "save final section" },
          { step: "submit final section", submitStep: true },
        ],
        submitEndpointPattern: "/api/wizard/(save|submit)-final$",
        requireSubmitEndpointMatch: true,
        ownBackendHostnames: [OWN_BACKEND_HOST],
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;

    // Never the discard/undercount phrasing — the declared pattern is never
    // silently overridden by the larger unfiltered decoy sequence.
    expect(output).not.toMatch(/ignoring submitEndpointPattern.*undercount/);

    // A warning-level surface that the two sequences disagreed must still
    // appear, so the flow author sees the gap without the pattern losing.
    expect(output).toMatch(/submitEndpointPattern.*disagrees with the unfiltered heuristic/);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // The submission target traces to the two pattern-matched captures...
    expect(contract).toContain("/api/wizard/save-final");
    expect(contract).toContain("/api/wizard/submit-final");

    // ...never to the larger, decoy-inflated heuristic sequence.
    for (let i = 0; i < DECOY_SECTION_COUNT; i++) {
      expect(contract).not.toContain(`/api/wizard/section-${i}`);
    }
  }, 30_000);
});
