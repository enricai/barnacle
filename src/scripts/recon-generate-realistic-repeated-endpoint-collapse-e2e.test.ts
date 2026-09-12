import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Full-pipeline regression for the report's own metric: three same-URL,
 * same-method capture groups — a paginated listing (varies only by a numeric
 * `page` field), a per-item drill (varies only by an item id nothing
 * downstream ever reads), and a zero-variance toggle re-poll — each repeated
 * many times, as in the report's available-products x8 / available-sailings
 * x6 / toggles x6 pattern (renamed here to a generic catalog domain per this
 * repo's site-agnostic rule). The fix must collapse all three groups to one
 * `httpClient` call each (3 total), not one hardcoded call per raw capture
 * (20 total).
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.own-backend-realistic-repeated-endpoint-collapse.example.com";
const TOGGLES_URL = `https://${OWN_BACKEND_HOST}/feature-toggles/catalog`;
const LISTING_URL = `https://${OWN_BACKEND_HOST}/catalog/listing`;
const DRILL_URL = `https://${OWN_BACKEND_HOST}/catalog/item-drill`;

const TOGGLES_POLL_COUNT = 6;
const LISTING_PAGE_COUNT = 8;
const DRILL_RETRY_COUNT = 6;

function reportShapeCaptures(): Capture[] {
  const toggles = Array.from({ length: TOGGLES_POLL_COUNT }, (_, i) =>
    buildCapture({
      url: TOGGLES_URL,
      requestPostData: "[]",
      responseBody: [{ name: "feature-a", enabled: true }],
      timestamp: `2024-01-01T00:00:${String(i).padStart(2, "0")}Z`,
    })
  );
  const listing = Array.from({ length: LISTING_PAGE_COUNT }, (_, i) =>
    buildCapture({
      url: LISTING_URL,
      requestPostData: JSON.stringify({ page: i + 1 }),
      responseBody: {
        totalPages: LISTING_PAGE_COUNT,
        items: [{ itemId: `item-${i + 1}` }],
      },
      timestamp: `2024-01-01T00:01:${String(i).padStart(2, "0")}Z`,
    })
  );
  // Every drill request carries its own scaffolding id, but that id never
  // shows up in any listing/toggle path, query, body, or response — nothing
  // downstream ever reads it, so it is structurally provable as dead
  // scaffolding rather than a genuine per-item join key.
  const drills = Array.from({ length: DRILL_RETRY_COUNT }, (_, i) =>
    buildCapture({
      url: DRILL_URL,
      requestPostData: JSON.stringify({ requestSeq: `req-${i + 1}` }),
      responseBody: { units: [{ unitId: `unit-${i + 1}` }], exchangeRate: 1.0 },
      timestamp: `2024-01-01T00:02:${String(i).padStart(2, "0")}Z`,
    })
  );
  return [...toggles, ...listing, ...drills];
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

describe("recon-generate CLI — three realistic repeated same-endpoint groups all collapse to one call each", () => {
  it("emits exactly one httpClient call per distinct endpoint group (3, not 20) with a bounded line count", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-realistic-repeated-endpoint-collapse-e2e-"));
    const runRoot = join(workDir, "run");
    const captures = reportShapeCaptures();
    writeRunDir(runRoot, captures);

    const siteId = `realistic-repeated-endpoint-collapse-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "poll feature toggles" },
          { step: "browse paged catalog listing" },
          { step: "drill into a catalog item", submitStep: true },
        ],
        submitEndpointPattern: "item-drill",
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

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    const httpClientCallCount = (contract.match(/await httpClient\(/g) ?? []).length;
    const lineCount = contract.split("\n").length;

    // Raw capture count is 20 (6 toggles + 8 listing pages + 6 drill
    // retries). Each of the three groups collapses to its own single
    // representative call — 3 total, the same order of magnitude as a
    // correctly-collapsed baseline, not one hardcoded call per repeat.
    expect(httpClientCallCount).toBe(3);
    expect(contract.match(/feature-toggles\/catalog/g)?.length).toBe(1);
    expect(contract.match(/catalog\/listing/g)?.length).toBe(1);
    expect(contract.match(/catalog\/item-drill/g)?.length).toBe(1);

    // A per-endpoint-group contract stays small and flat rather than scaling
    // with the repeat count — bounded well under what 20 unrolled calls
    // would produce (each hardcoded call plus its response typing runs to
    // several lines on its own).
    expect(lineCount).toBeLessThan(400);
  }, 30_000);
});
