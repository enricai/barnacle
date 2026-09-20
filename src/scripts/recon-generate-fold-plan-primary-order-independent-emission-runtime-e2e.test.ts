import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Complements recon-generate-fold-plan-primary-op-differs-from-emitted-primary-runtime-e2e.test.ts
 * (which pins the "no fold plan resolves at all" divergence case) by proving
 * the fix's other half through the real CLI: when a fold plan SHOULD resolve,
 * it must resolve against the SAME primary operation regardless of the file
 * order of an unrelated, structurally-noise-shaped capture that happens to
 * expose an object array at the exact same `resultsPath` the flow declares.
 * Before bugfix-001 (see docs/recon-generate-fold-plan-primary-op-can-differ-from-emitted-primary-op.md),
 * `buildFoldPlanFromSpec`/`detectDrillDownFoldPlan` searched for a primary
 * candidate purely structurally and last-write-wins across `actions` in
 * array order, with no anchor to the operation upstream already selected as
 * the emitted primary — so whichever structurally-matching capture (the
 * real `catalogSearch` primary or the noise `telemetryHeartbeat` capture,
 * which coincidentally shares its resultsPath shape) came later in the run
 * directory could silently win the fold plan, independent of which one was
 * actually emitted as the primary operation. This writes two run
 * directories differing ONLY in whether the noise capture or the real
 * primary capture is listed first, and asserts both runs exit 0 and emit
 * byte-identical generated contracts.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const SEARCH_QUERY = "query catalogSearch { catalog { results { items { id name } } } }";
// Declares an EARLIER object array (`meta.beacons`) than `catalog.results.items`
// so `dedupRedundantSameOperationCaptures`'s shape-key comparison (keyed on the
// FIRST object array `findObjectArrayField` finds) sees a different shape than
// the real primary and does not drop this capture as a redundant duplicate —
// unlike an otherwise-identical decoy, which the dedup pass silently removes
// before the fold-plan resolution under test ever runs.
const NOISE_QUERY =
  "query telemetryHeartbeat { meta { beacons { id } } catalog { results { items { id name } } } }";

function graphqlSearchCapture(index: number): unknown {
  return {
    timestamp: `2024-01-01T00:00:0${index}Z`,
    phase: "browse",
    method: "POST",
    url: "https://example.com/graphql",
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ query: SEARCH_QUERY, variables: {} }),
    responseHeaders: {},
    responseBody: {
      catalog: {
        results: {
          items: [
            { id: "item-a", name: "Widget" },
            { id: "item-b", name: "Gadget" },
          ],
        },
      },
    },
    operationName: "catalogSearch",
    query: SEARCH_QUERY,
    variables: {},
    decodedParams: null,
  };
}

// Same resultsPath shape as the real primary AND the same join id
// (`item-a`) the drill-down capture correlates against — so, pre-fix, the
// structural/spec search cannot tell them apart and either one can resolve
// a fold plan depending purely on array order. Captured once — never
// chosen as the emitted primary by selectPrimaryGraphQLOperation's
// scoring, which favors catalogSearch's higher recurrence.
function graphqlNoiseCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:05Z",
    phase: "browse",
    method: "POST",
    url: "https://example.com/graphql",
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ query: NOISE_QUERY, variables: {} }),
    responseHeaders: {},
    responseBody: {
      meta: { beacons: [{ id: "b1" }] },
      catalog: {
        results: {
          items: [{ id: "item-a", name: "Beacon" }],
        },
      },
    },
    operationName: "telemetryHeartbeat",
    query: NOISE_QUERY,
    variables: {},
    decodedParams: null,
  };
}

function restDrillDownCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:11Z",
    phase: "browse",
    method: "GET",
    url: "https://example.com/inventory/api/v1/items?id=item-a",
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: { items: [{ id: "item-a", qty: 7 }] },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

function writeRunDir(root: string, noiseFirst: boolean): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  // catalogSearch captured three times — more often than the noise
  // capture — so recurrenceScore prefers it as the emitted primary
  // regardless of which capture is listed first.
  const searchCaptures = [
    graphqlSearchCapture(1),
    graphqlSearchCapture(2),
    graphqlSearchCapture(3),
  ];
  const noiseCapture = graphqlNoiseCapture();
  const ordered = noiseFirst
    ? [noiseCapture, ...searchCaptures]
    : [...searchCaptures, noiseCapture];
  ordered.forEach((capture, index) => {
    writeFileSync(
      join(root, "graphql", `${String(index).padStart(3, "0")}-browse.json`),
      JSON.stringify(capture)
    );
  });
  writeFileSync(
    join(root, "graphql", `${String(ordered.length).padStart(3, "0")}-browse-drill.json`),
    JSON.stringify(restDrillDownCapture())
  );
}

function writeFlowFile(siteOutDir: string): void {
  mkdirSync(siteOutDir, { recursive: true });
  const flow: Record<string, unknown> = {
    steps: [{ step: "browse the catalog" }],
    foldReturn: {
      endpointPattern: "/inventory/api/v1/items",
      resultsPath: "catalog.results.items",
      drillResultsPath: "items",
      joinFields: ["id"],
    },
  };
  writeFileSync(join(siteOutDir, "recon-flow.json"), JSON.stringify(flow));
}

let workDirs: string[] = [];
let siteOutDirs: string[] = [];

afterEach(() => {
  for (const dir of workDirs) rmSync(dir, { recursive: true, force: true });
  for (const dir of siteOutDirs) rmSync(dir, { recursive: true, force: true });
  workDirs = [];
  siteOutDirs = [];
});

function run(runRoot: string, siteId: string): ReturnType<typeof spawnSync> {
  return spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
}

describe("recon-generate fold plan primary resolution — order independence runtime e2e", () => {
  it("resolves the same emitted primary and fold/drill wiring regardless of noise-vs-real capture order", () => {
    // Both orderings use the SAME siteId (run sequentially, not in parallel)
    // so the only difference between the two generated contracts is the
    // capture file order — a differing siteId would leak into every
    // generated identifier name and mask a byte-for-byte comparison.
    const siteId = `fold-primary-order-test-run${process.pid}`;
    const siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    siteOutDirs.push(siteOutDir);
    writeFlowFile(siteOutDir);

    const contracts = [true, false].map((noiseFirst) => {
      const workDir = mkdtempSync(join(tmpdir(), "barnacle-fold-primary-order-"));
      workDirs.push(workDir);
      const runRoot = join(workDir, "run");
      writeRunDir(runRoot, noiseFirst);

      const result = run(runRoot, siteId);
      const out = `${result.stdout}\n${result.stderr}`;

      expect(result.status, out).toBe(0);
      expect(out).not.toContain("differs from the emitted primary operation");
      expect(out).not.toContain("no fold plan resolved");

      return readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    });

    const [noiseFirstContract, realFirstContract] = contracts as [string, string];

    // Both orderings must resolve the fold plan against the real
    // catalogSearch primary and wire the same drill endpoint — never the
    // noise capture's shape.
    for (const contract of [noiseFirstContract, realFirstContract]) {
      expect(contract).toContain("catalogSearch");
      expect(contract).not.toContain("telemetryHeartbeat");
      expect(contract).toContain("/inventory/api/v1/items");
    }

    expect(noiseFirstContract).toBe(realFirstContract);
  }, 30_000);
});
