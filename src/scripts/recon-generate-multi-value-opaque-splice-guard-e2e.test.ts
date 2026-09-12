import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Extends recon-generate-opaque-endpoint-payload-splice-guard-e2e's single-value
 * pin to TWO simultaneously-threaded fields of different lengths
 * (`pageSize=12`, `pageIndex=345`) whose digits both coincidentally appear
 * inside the SAME hyphen-joined opaque path segment
 * (`wJbfQL-12-345-K0X`). `parameterizeUrl`'s fold-chain URL builder
 * (recon-generate.ts, emitContractTs) and `parameterize`'s (emitMultiStepExecuteHttp)
 * used to run a per-field `threadedFieldPairs.reduce((acc, ...) => acc.replace(...),
 * text)` — a sequential pass over an ACCUMULATOR that already carries the
 * PRIOR field's `${...}` substitution text. With two threaded values active at
 * once, that shape is the exact reentrant-match vulnerability class #372's own
 * commit message describes fixing for `interpolateStateValues` but never
 * touched here: this pins that neither value gets spliced into the opaque
 * segment and no invalid nested `${...}` placeholder is ever produced,
 * regardless of processing order between the two fields.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "jobs.example.com";
const OPAQUE_SEGMENT = "wJbfQL-12-345-K0X";
const BEACON_URL = `https://${OWN_BACKEND_HOST}/beacon/${OPAQUE_SEGMENT}/responder.html?pageSize=12&pageIndex=345&env=prod`;

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
        postings: [{ postingId: "job-1", pageSize: 12, pageIndex: 345 }],
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

describe("recon-generate CLI — an opaque path segment coincidentally matching TWO distinct threaded values survives both", () => {
  it("never splices either coincidental value into the opaque segment and never emits an invalidly-nested placeholder", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-multi-value-opaque-splice-guard-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `multi-value-opaque-splice-guard-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    writeFlowFile(siteOutDir);

    const result = generate(runRoot, siteId);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // No invalidly-nested placeholder anywhere in the emitted file — the
    // core assertion: two simultaneously-active threaded values must never
    // let one's substitution text get re-matched by the other's pass.
    expect(contract).not.toMatch(/\$\{[^}]*\$\{/);

    const beaconLineMatch = contract.match(/`[^`]*wJbfQL[^`]*K0X[^`]*`/);
    expect(beaconLineMatch, contract).not.toBeNull();
    const beaconUrlTemplate = beaconLineMatch![0];

    // Isolate the opaque path segment (between the fixed `wJbfQL-` prefix and
    // `-K0X` suffix) — the fixture's numeric field names legitimately appear
    // in the query string (`pageSize=${...}&pageIndex=${...}`), so the guard
    // checks only the opaque slot itself.
    const opaqueSlotMatch = beaconUrlTemplate.match(/wJbfQL-(.*?)-K0X/);
    expect(opaqueSlotMatch, beaconUrlTemplate).not.toBeNull();
    const opaqueSlot = opaqueSlotMatch![1]!;

    // Neither coincidentally-matching field must ever get spliced into the
    // opaque segment.
    expect(opaqueSlot).not.toContain("pageSize");
    expect(opaqueSlot).not.toContain("pageIndex");
    expect(opaqueSlot).not.toMatch(/\$\{/);

    // If the endpoint ends up rendered as an exact literal (no ${...} at
    // all in its path), it must match the captured URL byte-for-byte.
    if (!beaconUrlTemplate.includes("${")) {
      expect(beaconUrlTemplate).toContain(OPAQUE_SEGMENT);
    }
  }, 30_000);
});
