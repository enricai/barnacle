import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Full-pipeline regression through the real `recon-generate` CLI: a search
 * endpoint that fires repeatedly (19 times, each with a varying request body
 * and varying results) is a legitimate real-call primary, not noise, and a
 * declared `foldReturn` against a later matching drill capture must still
 * resolve. Before the fix, repeated calls to the same endpoint could be
 * excluded from the fold candidate pool, leaving `main()` to log "no fold
 * plan resolved" and the emitted contract to omit the drilled field.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.repeated-primary-fixture.example.com";
const SEARCH_URL = `https://${OWN_BACKEND_HOST}/catalog-search/`;
const DRILL_URL = `https://${OWN_BACKEND_HOST}/catalog-detail/`;

const SEARCH_CALL_COUNT = 19;

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

function runGenerate(siteId: string, runRoot: string): ReturnType<typeof spawnSync> {
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

describe("recon-generate CLI: a repeatedly-called search primary is never excluded from the fold candidate pool", () => {
  it("resolves the fold plan and never warns 'no fold plan resolved' when the search endpoint fires 19 times with varying body/results", () => {
    // Every occurrence carries a distinct request body (page number) and a
    // distinct results page, so this is a real paginated call sequence
    // rather than the zero-variance/freely-varying noise shapes the sibling
    // regressions pin — it must still be recognized as the real primary.
    const searchCaptures: Capture[] = Array.from({ length: SEARCH_CALL_COUNT }, (_, i) =>
      buildCapture({
        url: SEARCH_URL,
        requestPostData: JSON.stringify({ page: i + 1 }),
        responseBody: {
          results: [
            { id: `item-${i}-a`, name: `Item ${i} A` },
            { id: `item-${i}-b`, name: `Item ${i} B` },
          ],
        },
        timestamp: `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`,
      })
    );

    const drill = buildCapture({
      url: DRILL_URL,
      requestPostData: JSON.stringify({ id: "item-0-a" }),
      responseBody: { detail: { id: "item-0-a", price: 42 } },
      timestamp: "2026-01-01T00:00:20Z",
    });

    const allCaptures = [...searchCaptures, drill];
    expect(allCaptures).toHaveLength(SEARCH_CALL_COUNT + 1);

    workDir = mkdtempSync(join(tmpdir(), "barnacle-repeated-primary-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, allCaptures);

    const siteId = `repeated-primary-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "search catalog" }, { step: "view item detail", submitStep: true }],
        submitEndpointPattern: "catalog-detail",
        requireSubmitEndpointMatch: true,
        ownBackendHostnames: [OWN_BACKEND_HOST],
        foldReturn: {
          endpointPattern: "/catalog-detail/",
          resultsPath: "results",
          drillResultsPath: "detail",
          joinFields: ["id"],
        },
      })
    );

    const result = runGenerate(siteId, runRoot);
    const out = `${result.stdout}\n${result.stderr}`;

    expect(result.status, out).toBe(0);
    expect(out).not.toContain("no fold plan resolved");

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    expect(contract).toContain("catalog-search/");
    expect(contract).toContain("catalog-detail/");
    expect(contract).toContain("price");
  }, 30_000);
});
