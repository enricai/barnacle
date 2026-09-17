import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins the 1.12.51 report's "currency" finding onto the ONE structural shape
 * no existing regression covers: a caller-supplied top-level field
 * (`storeCurrency`) that correctly binds to `payload.storeCurrency` on the
 * entry call must resolve to that SAME accessor on every later call too,
 * including a call inside a per-item fold/drill LOOP over the primary array
 * (`for (const g0 of ...)`-shaped) and a further chained call nested one hop
 * past that loop body — never falling back to a scraped, hardcoded
 * array-index accessor into the entry call's own response just because this
 * loop+chained-drill shape wasn't previously exercised. Modeled on
 * recon-generate-multicall-fixture's
 * `buildMulticallSingleShotSearchDrillDownChainedDependentActionSteps` (the
 * only existing fixture with a genuine 3-step drill CHAIN — primary -> drill
 * -> a further call depending on the drill's own response) combined with the
 * 1.12.51 combined-verification-hooks-e2e's CLI/`--force` harness and
 * same-name-field assertion style.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.currency-multicall-payload-precedence-e2e-fixture.example.com";
const SEARCH_URL = `https://${OWN_BACKEND_HOST}/catalog/search/`;
const PRICING_URL = `https://${OWN_BACKEND_HOST}/catalog/pricing/`;
// A plain single-word path segment (no hyphen) — a compound, hyphenated
// segment (e.g. "price-history") tokenizes into words that share nothing
// with the entry/loop calls' own plain-word paths ("search"/"pricing"),
// which extractActionSequence's structural-isolation pass
// ({@link isStructurallyIsolatedCapture} in src/recon/capture-filters.ts)
// then drops from the action sequence entirely — defeating the very chain
// this fixture exists to exercise.
const PRICE_HISTORY_URL = `https://${OWN_BACKEND_HOST}/catalog/pricehistory/`;

// Exactly MIN_STATE_VALUE_LENGTH (8) so the coincidental scraped occurrence
// below genuinely qualifies for ordinary state-value indexing (no
// too-short-to-index exemption masking the guard this test targets).
const STORE_CURRENCY_VALUE = "usdcurr1";

function fixtureCaptures(): Capture[] {
  // Entry call: `storeCurrency` is the caller's own top-level field — the
  // legitimate `payload.storeCurrency` source that must keep winning on
  // every later call, including inside the fold loop below. The primary
  // array's own items each ALSO carry the exact same value at a nested
  // array path (`tags[0]`) — a genuine competing scraped, hardcoded
  // array-index accessor into THIS response, not merely a too-short or
  // absent decoy.
  const search = buildCapture({
    url: SEARCH_URL,
    requestPostData: JSON.stringify({ storeCurrency: STORE_CURRENCY_VALUE, page: 1 }),
    responseBody: {
      results: [
        { sku: "sku-a", tags: [STORE_CURRENCY_VALUE, "other"] },
        { sku: "sku-b", tags: [STORE_CURRENCY_VALUE, "other"] },
      ],
    },
    timestamp: "2026-06-01T00:00:00Z",
  });
  // Per-item fold LOOP body call — re-sends `storeCurrency` under its own
  // name. Recorded once (for sku-a); the generator's per-item fold loop
  // re-issues this call's own rendered template for every primary item at
  // runtime, so a single recorded occurrence still exercises the loop shape.
  const drill = buildCapture({
    url: PRICING_URL,
    requestPostData: JSON.stringify({ sku: "sku-a", storeCurrency: STORE_CURRENCY_VALUE }),
    responseBody: {
      priceToken: "tok-sku-a",
      prices: [{ sku: "sku-a", amount: 19.99 }],
    },
    timestamp: "2026-06-01T00:00:01Z",
  });
  // A further call CHAINED one hop past the drill (depends on the drill's
  // own `priceToken`, per computeFoldChain) — nested inside the same
  // per-item loop — that ALSO re-sends `storeCurrency` under its own name.
  const history = buildCapture({
    url: PRICE_HISTORY_URL,
    requestPostData: JSON.stringify({
      priceToken: "tok-sku-a",
      storeCurrency: STORE_CURRENCY_VALUE,
    }),
    responseBody: {
      history: [{ sku: "sku-a", amount: 18.5, asOf: "2026-05-01" }],
    },
    timestamp: "2026-06-01T00:00:02Z",
  });
  return [search, drill, history];
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

describe("recon-generate CLI — currency multicall payload precedence through a fold loop + chained drill", () => {
  it("sources payload.storeCurrency on the entry call, the fold-loop body call, AND the chained call nested inside that loop", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-currency-multicall-payload-precedence-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `currency-multicall-payload-precedence-e2e-test${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "browse catalog search" }],
        ownBackendHostnames: [OWN_BACKEND_HOST],
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contractPath = join(siteOutDir, "contract.ts");
    const contract = readFileSync(contractPath, "utf8");

    // The generator resolved a genuine per-item fold loop, not a flat chain
    // — proves the loop+chained-drill shape this test targets was actually
    // exercised, not silently collapsed to a single-item linear plan.
    expect(contract).toMatch(/\(\w+\)\.map\(async \(\w+\) => \{/);

    // Every request-body occurrence of `storeCurrency` — the entry call, the
    // loop body call, and the chained call nested inside the loop — must
    // source from `payload.storeCurrency`.
    const storeCurrencyOccurrences = [
      ...contract.matchAll(/"storeCurrency"\s*:\s*"?\$\{([^}]*)\}"?/g),
    ];
    expect(storeCurrencyOccurrences.length).toBeGreaterThanOrEqual(3);
    for (const match of storeCurrencyOccurrences) {
      expect(match[1], contract).toContain("payload.storeCurrency");
    }

    // Never a scraped, hardcoded array-index accessor into the entry
    // response's own `tags` array (e.g. `results["0"].tags["0"]` or
    // `g0.tags[0]`) — the coincidental competing occurrence this fixture's
    // primary response deliberately carries.
    expect(contract).not.toMatch(/"storeCurrency"\s*:\s*"?\$\{[^}]*tags\[["'`]?0["'`]?\][^}]*\}/i);
    expect(contract).not.toMatch(/"storeCurrency"\s*:\s*"?\$\{[^}]*\.tags\.0[^}]*\}/i);

    // No invalidly-nested placeholder anywhere in the emitted output.
    expect(contract).not.toMatch(/\$\{[^}]*\$\{/);
  }, 30_000);
});
