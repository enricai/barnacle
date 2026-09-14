import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Extends recon-generate-multi-value-opaque-splice-guard-e2e's two-value pin to
 * a corpus on the order of the report's own evidence: compileActionSteps'
 * seenNames-collision-suffix pattern (recon-generate.ts ~4381-4388 —
 * `displayOrder`, `displayOrder2`, ... `displayOrder212`) shows a single
 * non-collapsed primary array can legitimately produce hundreds of distinct
 * state values from one flow. `parameterize`'s fold-chain rerun
 * (emitMultiStepExecuteHttp, ~5940-6004) reruns `substituteThreadedValues`
 * over Pass 1's ALREADY-INTERPOLATED URL text for the matched item — the
 * exact double-pass shape that previously let a later pass reopen a `${...}`
 * placeholder an earlier pass had already emitted, because
 * `replaceGuardedAgainstExistingPlaceholders`'s protected-span regex
 * (`/\$\{[^{}]*\}/`) could not see past a placeholder's own inner braces once
 * one nesting had already occurred. This pins the invariant against a corpus
 * two orders of magnitude larger than the previously-tested 2-3 values, so a
 * regression in the guard's generality (vs. a fixture-shaped special case)
 * would show up here even if it didn't show up at small scale.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "widgets.example.com";
const CORPUS_SIZE = 120;

function corpusValue(index: number): string {
  // 10-char alphanumeric, distinct per index, generic domain naming (no
  // reference to any real site/plugin) — long enough to clear
  // MIN_STATE_VALUE_LENGTH and short enough to plausibly substring-match an
  // opaque token by coincidence.
  return `gv${index.toString(36).padStart(6, "0")}xx`;
}

// The opaque path segment coincidentally embeds two arbitrary corpus values
// (indices 1 and 60) inside a hyphen-joined, non-word-boundary-safe shape —
// the same coincidence class the multi-value test pins, but now amid a
// corpus 40-60x larger.
const SPLICE_TARGET_A = corpusValue(1);
const SPLICE_TARGET_B = corpusValue(60);
const OPAQUE_SEGMENT = `wJbfQL-${SPLICE_TARGET_A}-${SPLICE_TARGET_B}-K0X`;
const BEACON_URL = `https://${OWN_BACKEND_HOST}/beacon/${OPAQUE_SEGMENT}/responder.html?env=prod`;

function searchCapture(): unknown {
  const postings = Array.from({ length: CORPUS_SIZE }, (_, i) => ({
    postingId: i === 0 ? "item-1" : `item-${i + 1}`,
    genericField: corpusValue(i),
  }));
  return {
    timestamp: "2024-01-01T00:00:00Z",
    phase: "action",
    method: "POST",
    url: `https://${OWN_BACKEND_HOST}/api/v1/widgets/search`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: '{"page":1}',
    responseHeaders: { "content-type": "application/json" },
    responseBody: {
      results: { postings },
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
    responseBody: { pixels: [{ postingId: "item-1", ack: true }] },
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
      steps: [{ step: "search widgets" }, { step: "record view beacon", submitStep: true }],
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

describe("recon-generate CLI — 100+ threaded state values plus one same-host opaque-path endpoint", () => {
  it("never nests a placeholder and never splices a produced value into the opaque path, at large corpus scale", () => {
    workDir = mkdtempSync(
      join(tmpdir(), "barnacle-value-coincidence-large-corpus-and-path-segment-threading-")
    );
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `value-coincidence-large-corpus-and-path-segment-threading-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    writeFlowFile(siteOutDir);

    const result = generate(runRoot, siteId);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // The core structural invariant: with a corpus two orders of magnitude
    // larger than previously pinned, the emitted file must still never open
    // a `${` before a prior `${...}` closes, anywhere in the file.
    expect(contract).not.toMatch(/\$\{[^}]*\$\{/);

    const beaconLineMatch = contract.match(/`[^`]*wJbfQL[^`]*K0X[^`]*`/);

    // As with the sibling e2e, the beacon may legitimately be excluded as
    // noise — either outcome is acceptable, but if it IS emitted, its opaque
    // segment must be untouched by any of the 120 threaded producer values.
    if (!beaconLineMatch) return;

    const beaconUrlTemplate = beaconLineMatch[0];
    const opaqueSlotMatch = beaconUrlTemplate.match(/wJbfQL-(.*?)-K0X/);
    expect(opaqueSlotMatch, beaconUrlTemplate).not.toBeNull();
    const opaqueSlot = opaqueSlotMatch![1]!;

    expect(opaqueSlot).not.toMatch(/\$\{/);
    for (let i = 0; i < CORPUS_SIZE; i++) {
      expect(opaqueSlot).not.toContain(`genericField${i > 0 ? i + 1 : ""}`);
    }

    if (!beaconUrlTemplate.includes("${")) {
      expect(beaconUrlTemplate).toContain(OPAQUE_SEGMENT);
    }
  }, 60_000);
});
