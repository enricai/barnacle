import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Required item 2: once the corrected action sequence legitimately resolves
 * to a true single-endpoint flow (fewer than 2 steps), primary/winningCapture
 * selection on that single-endpoint path must still honor a declared
 * `submitEndpointPattern` (with `requireSubmitEndpointMatch` set) rather than
 * falling through to the free heuristic, which would otherwise let a
 * page-load-fired, same-own-backend-host decoy (mirroring the report's
 * toggles/product-avail shape) win.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.single-endpoint-required-match-fixture.example.com";

function restCapture(overrides: {
  method: string;
  url: string;
  requestPostData: string | null;
  responseBody: unknown;
}): Capture {
  return {
    timestamp: "2026-09-09T10:23:03.000Z",
    phase: "home",
    method: overrides.method,
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

/**
 * A page-load-fired decoy on the same own-backend host — mirroring the
 * report's toggles/product-avail shape — that fires before the real
 * submission. It must be POST: `firstEndpointCapture` restricts its first
 * pass to non-GET captures before ever consulting `submitPatterns`, so a GET
 * decoy would be filtered out by that pass regardless of the fix under test,
 * silently passing either way. Its path segment (`/errors/`) is an
 * error-reporting-sink path excluded from `extractActionSequence`'s noise
 * filter, so the corrected action sequence resolves to the single real
 * step below — but the decoy remains a visible, host-allowed candidate to
 * the single-endpoint primary-capture selection functions, which apply no
 * noise filter of their own.
 */
function pageLoadDecoyCapture(): Capture {
  return restCapture({
    method: "POST",
    url: `https://${OWN_BACKEND_HOST}/api/errors/product-avail-toggle`,
    requestPostData: JSON.stringify({ toggle: "avail" }),
    responseBody: { available: true, decoy: true },
  });
}

/** The single capture the declared pattern matches — the real submission endpoint. */
function patternMatchedCapture(): Capture {
  return restCapture({
    method: "POST",
    url: `https://${OWN_BACKEND_HOST}/api/submit-final`,
    requestPostData: JSON.stringify({ item: "widget" }),
    responseBody: { submitted: true },
  });
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

describe("recon-generate CLI — single-endpoint primary selection honors requireSubmitEndpointMatch", () => {
  it("emits the declared-pattern capture as primary, never the page-load decoy, once the corrected sequence is a single step", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-single-endpoint-required-match-e2e-"));
    const runRoot = join(workDir, "run");
    // Decoy written first so a chronological/scoring-only heuristic would
    // pick it over the declared pattern's match, if the pattern were ignored.
    writeRunDir(runRoot, [pageLoadDecoyCapture(), patternMatchedCapture()]);

    const siteId = `single-endpoint-required-match-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "submit the widget order" }],
        submitEndpointPattern: "/api/submit-final$",
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
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/single-endpoint REST/);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // The primary/winning capture traces to the declared pattern's match...
    expect(contract).toContain("/api/submit-final");

    // ...never to the earlier page-load decoy.
    expect(contract).not.toContain("/api/errors/product-avail-toggle");
    expect(contract).not.toContain("decoy");
  }, 30_000);
});
