import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Reproduces the report's new corrupted-URL-templating defect: a same-host,
 * fixed-query, zero-request-variance beacon-style call (a page-view pixel,
 * modeling no real site) whose base64-like opaque path segment coincidentally
 * contains a digit substring equal to an unrelated primary item's numeric
 * field value. `parameterizeUrl`'s per-field `acc.replace(new RegExp('\\b' +
 * value + '\\b', 'g'), ...)` (recon-generate.ts ~9339) is applied globally
 * once ANY occurrence of that value legitimately confirms the field as
 * threaded (here, the beacon's own fixed `pageSize=12` query param) — so the
 * same regex also splices into the opaque segment's coincidental `-12-`
 * substring, which has nothing to do with the field.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "jobs.example.com";
const OPAQUE_SEGMENT = "wJbfQL-12-K0X";
const BEACON_URL = `https://${OWN_BACKEND_HOST}/beacon/${OPAQUE_SEGMENT}/responder.html?pageSize=12&env=prod`;

function searchCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:00Z",
    phase: "action",
    method: "POST",
    url: `https://${OWN_BACKEND_HOST}/api/v1/postings/search`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: '{"page":1}',
    responseHeaders: { "content-type": "application/json" },
    responseBody: {
      results: {
        postings: [{ postingId: "job-1", pageSize: 12 }],
      },
    },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

function beaconCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:01Z",
    phase: "action",
    method: "GET",
    url: BEACON_URL,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: { "content-type": "application/json" },
    responseBody: { pixels: [{ postingId: "job-1", ack: true }] },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

function writeRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));
  writeFileSync(join(root, "graphql", "000-browse-search.json"), JSON.stringify(searchCapture()));
  writeFileSync(join(root, "graphql", "001-browse-beacon.json"), JSON.stringify(beaconCapture()));
}

function writeFlowFile(siteOutDir: string): void {
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({
      steps: [{ step: "search job postings" }, { step: "record view beacon", submitStep: true }],
      ownBackendHostnames: [OWN_BACKEND_HOST],
      foldReturn: {
        endpointPattern: "/beacon/",
        resultsPath: "results.postings",
        drillResultsPath: "pixels",
        joinFields: ["postingId"],
      },
    })
  );
}

function generate(runRoot: string, siteId: string): ReturnType<typeof spawnSync> {
  return spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate CLI — a fixed-query opaque-path beacon endpoint survives a coincidental numeric-field collision", () => {
  it("never splices a payload field into the beacon's opaque path segment and never emits invalidly-nested placeholders", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-opaque-endpoint-splice-guard-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `opaque-endpoint-splice-guard-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    writeFlowFile(siteOutDir);

    const result = generate(runRoot, siteId);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // No invalidly-nested placeholder anywhere in the emitted file.
    expect(contract).not.toMatch(/\$\{[^}]*\$\{/);

    // Locate the beacon call's rendered path text (still containing the
    // opaque segment's fixed prefix/suffix, whether or not the middle
    // digits were left literal or (incorrectly) spliced).
    const beaconLineMatch = contract.match(/`[^`]*wJbfQL[^`]*K0X[^`]*`/);
    expect(beaconLineMatch, contract).not.toBeNull();
    const beaconUrlTemplate = beaconLineMatch![0];

    // Isolate the opaque path segment (between the fixed `wJbfQL-` prefix and
    // `-K0X` suffix) from the rest of the URL template — the fixture's
    // numeric field name legitimately appears in the query string
    // (`pageSize=${...}`), so the guard checks only the opaque slot itself.
    const opaqueSlotMatch = beaconUrlTemplate.match(/wJbfQL-(.*?)-K0X/);
    expect(opaqueSlotMatch, beaconUrlTemplate).not.toBeNull();
    const opaqueSlot = opaqueSlotMatch![1]!;

    // The fixture's numeric field name must never appear inside the opaque
    // segment — it is not a real accessor for this coincidental digit run.
    expect(opaqueSlot).not.toContain("pageSize");

    // If the endpoint ends up rendered as an exact literal (no ${...} at
    // all in its path), it must match the captured URL byte-for-byte.
    if (!beaconUrlTemplate.includes("${")) {
      expect(beaconUrlTemplate).toContain(OPAQUE_SEGMENT);
    }
  }, 30_000);
});
