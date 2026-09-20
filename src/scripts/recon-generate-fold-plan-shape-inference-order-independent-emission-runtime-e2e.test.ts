import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Complements recon-generate-fold-plan-primary-order-independent-emission-runtime-e2e.test.ts
 * (which pins WHICH capture wins the fold plan, using a noise/real pair that
 * coincidentally share the same shape at `foldReturn.resultsPath`, so a
 * shape-inference divergence at `selectEffectiveResponseBody`'s own call
 * site never surfaces through that fixture) by proving the fix's other half
 * through the real CLI: the noise and real candidates here fold to
 * DIFFERING shapes at the resolved primary's own array — the noise capture
 * carries a `meta.beacons` array (paired with a `total` count field) that
 * satisfies `detectPaginationSignal`'s bounded-paging heuristic, while the
 * real `catalogSearch` capture carries neither. `emitContractTs` runs an
 * internal consistency check between the paginated array `detectPaginationSignal`
 * finds (derived from `selectEffectiveResponseBody`'s pick) and the fold
 * plan's own primary array path, and throws
 * ("... no longer extends the paginated collection's own array path ...")
 * when the two disagree — exactly what happens pre-fix when the unanchored
 * search picks the noise capture as the effective primary while the
 * anchored fold plan (already fixed for `resolveApplicableFoldPlans`, see
 * PR #436) still targets the real one. Before this fix
 * (`a150d5c`/bugfix-001), whichever structurally-matching capture — the
 * real `catalogSearch` primary or the noise `telemetryHeartbeat` capture —
 * came later in the run directory won `selectEffectiveResponseBody`'s own
 * unanchored fold-plan resolution independent of order, so one of the two
 * capture orderings below crashes generation entirely while the other
 * succeeds. After the fix, both orderings resolve
 * `selectEffectiveResponseBody`'s fold plan against the SAME anchored
 * primary (the real `catalogSearch` capture, which trips no pagination
 * signal), so both exit 0 and emit byte-identical contracts.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const SEARCH_QUERY =
  "query catalogSearch($first: Int, $skip: Int) { catalog(first: $first, skip: $skip) { results { items { id name } } } }";
// Declares an EARLIER object array (`meta.beacons`, paired with a sibling
// `total` count) than `catalog.results.items` so `dedupRedundantSameOperationCaptures`'s
// shape-key comparison (keyed on the FIRST object array `findObjectArrayField`
// finds) sees a different shape than the real primary and does not drop this
// capture as a redundant duplicate. `meta.beacons` is also what makes this
// capture's shape genuinely DIVERGE from the real primary's: it satisfies
// `detectPaginationSignal`'s bounded-paging check (2 items, evenly divides
// the real primary's own `first: 2` page size, paired with the `total` field)
// while the real primary's own shape trips no such signal at all.
const NOISE_QUERY =
  "query telemetryHeartbeat { meta { beacons { id } } catalog { results { total items { id name } } } }";

function graphqlSearchCapture(index: number): unknown {
  return {
    timestamp: `2024-01-01T00:00:0${index}Z`,
    phase: "browse",
    method: "POST",
    url: "https://example.com/graphql",
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ query: SEARCH_QUERY, variables: { first: 2, skip: 0 } }),
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
    variables: { first: 2, skip: 0 },
    decodedParams: null,
  };
}

// Same resultsPath as the real primary and the same join id (`item-a`) the
// drill-down capture correlates against, but its shape genuinely diverges
// via the sibling `meta.beacons`/`total` fields described above — a shape
// DIVERGENCE, not a coincidental match. Never chosen as the emitted primary
// by selectPrimaryGraphQLOperation's scoring, which favors catalogSearch's
// higher recurrence.
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
      meta: { beacons: [{ id: "b1" }, { id: "c2" }] },
      catalog: {
        results: {
          total: 10,
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

describe("recon-generate fold plan shape inference — order independence runtime e2e", () => {
  it("resolves the same generated response shape regardless of noise-vs-real capture order", () => {
    // Both orderings use the SAME siteId (run sequentially, not in parallel)
    // so the only difference between the two generated contracts is the
    // capture file order — a differing siteId would leak into every
    // generated identifier name and mask a byte-for-byte comparison.
    const siteId = `fold-shape-order-test-run${process.pid}`;
    const siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    siteOutDirs.push(siteOutDir);
    writeFlowFile(siteOutDir);

    const contracts = [true, false].map((noiseFirst) => {
      const workDir = mkdtempSync(join(tmpdir(), "barnacle-fold-shape-order-"));
      workDirs.push(workDir);
      const runRoot = join(workDir, "run");
      writeRunDir(runRoot, noiseFirst);

      const result = run(runRoot, siteId);
      const out = `${result.stdout}\n${result.stderr}`;

      // Pre-fix, whichever ordering resolves selectEffectiveResponseBody's
      // unanchored fold plan onto the noise capture trips emitContractTs's
      // own pagination/fold-plan consistency guard and exits non-zero —
      // this is exactly the divergence this test pins closed.
      expect(result.status, out).toBe(0);
      expect(out).not.toContain("differs from the emitted primary operation");
      expect(out).not.toContain("no fold plan resolved");

      return readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    });

    const [noiseFirstContract, realFirstContract] = contracts as [string, string];

    // Neither ordering may infer the response shape from the noise
    // capture's shape — the generated contract must never carry its
    // noise-only identifiers, and both orderings must agree byte-for-byte.
    for (const contract of [noiseFirstContract, realFirstContract]) {
      expect(contract).toContain("catalogSearch");
      expect(contract).not.toContain("telemetryHeartbeat");
      expect(contract).toContain("/inventory/api/v1/items");
    }

    expect(noiseFirstContract).toBe(realFirstContract);
  }, 30_000);
});
