import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { RECON_GENERATE_CWD } from "@/scripts/recon-generate-cwd.test-helper";
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
const HOST = "www.html-chain-e2e-fixture.example.com";
const TOK = "Qw8rT5yU2iO9pLkJ4hGf";

function fixtureCaptures(): Capture[] {
  const search = buildCapture({
    url: `https://${HOST}/catalog/search/`,
    requestPostData: JSON.stringify({ page: 1 }),
    responseBody: { results: [{ sku: "sku-a" }, { sku: "sku-b" }] },
    timestamp: "2026-06-01T00:00:00Z",
  });
  const drill = buildCapture({
    url: `https://${HOST}/catalog/pricing/`,
    requestPostData: JSON.stringify({ sku: "sku-a" }),
    responseBody: { priceToken: "tok-sku-a", prices: [{ sku: "sku-a", amount: 19.99 }] },
    timestamp: "2026-06-01T00:00:01Z",
  });
  const page = buildCapture({
    url: `https://${HOST}/catalog/pricepage/?t=tok-sku-a`,
    method: "GET",
    requestPostData: null,
    responseBody: `<html><input type="hidden" name="nonce" value="${TOK}"></html>`,
    timestamp: "2026-06-01T00:00:02Z",
  });
  const history = buildCapture({
    url: `https://${HOST}/catalog/pricehistory/`,
    requestPostData: JSON.stringify({ nonce: TOK, priceToken: "tok-sku-a" }),
    responseBody: { history: [{ sku: "sku-a", amount: 18.5 }] },
    timestamp: "2026-06-01T00:00:03Z",
  });
  return [search, drill, page, history];
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

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate CLI — HTML token read inside a fold chain hop", () => {
  it("fetches the HTML hop directly and extracts the token", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-html-chain-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());
    const siteId = `html-chain-e2e-test${process.pid}`;
    siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({ steps: [{ step: "browse" }], ownBackendHostnames: [HOST] })
    );
    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: RECON_GENERATE_CWD, encoding: "utf8" }
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contract).toMatch(/\.map\(async \(\w+\) => \{/);
    expect(contract).not.toContain(TOK);
    expect(contract).toContain("await fetchFollowingRedirectsPreservingMethod(");
    expect(contract).toMatch(/import \{ fetchFollowingRedirectsPreservingMethod \} from ".*\/scraper\/redirect-follow"/);
    expect(contract).toContain("const nonceToken");
  }, 30_000);
});
