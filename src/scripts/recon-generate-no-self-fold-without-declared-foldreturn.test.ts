import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectDrillDownFoldPlan } from "@/scripts/recon-generate";
import { RECON_GENERATE_CWD } from "@/scripts/recon-generate-cwd.test-helper";
import { buildStep, type MulticallFixtureStep } from "@/scripts/recon-generate-multicall-fixture";

/**
 * A read-only GET search re-queried under a different facet.
 *
 * Both captures hit the SAME endpoint; only the query differs. The search's own
 * results carry `brandCode` and `size` values that the facet re-query then
 * sends as `brand`/`size`, which is what makes the structural detector pair
 * them as a per-item drill-down. The flow declares no `foldReturn`, so that
 * pairing is a phantom self-fold, and emitting it would freeze `qty`/`region`
 * — the facet variation the flow author deliberately recorded.
 */
function buildFacetRequeriedSearchSteps(): MulticallFixtureStep[] {
  const search = (query: string, timestamp: string): MulticallFixtureStep =>
    buildStep(`r${timestamp.slice(-1)}`, {
      url: `https://api.example.com/catalog/search?${query}`,
      requestPostData: null,
      method: "GET",
      timestamp,
      responseBody: {
        results: {
          items: [
            { id: "I1", brandCode: "CB", originCode: "MIA", size: 7 },
            { id: "I2", brandCode: "VI", originCode: "PCN", size: 5 },
          ],
        },
      },
    });

  return [
    search("qty=2&region=C", "2026-11-02T12:00:01.000Z"),
    // The facet re-query: same endpoint, threads "CB" and "7" from the first
    // response's own items, and varies qty/region at the same time.
    search("qty=3&region=A&brand=CB&size=7", "2026-11-02T12:00:02.000Z"),
  ];
}

/** `detectDrillDownFoldPlan` takes the unexported `ActionStep[]`; the shared fixture's
 * `MulticallFixtureStep` is structurally identical except for `produces` (`unknown[]` vs the
 * real `Produce[]`, always empty here — the detector never reads it), so a type-only cast
 * through the detector's own parameter type is safe. Mirrors `detectAll` in
 * `recon-generate-fold-plan.test.ts`, with the new flag exposed. */
function detectAll(
  steps: MulticallFixtureStep[],
  allowSelfEndpointDrill: boolean
): ReturnType<typeof detectDrillDownFoldPlan> {
  return detectDrillDownFoldPlan(
    steps as unknown as Parameters<typeof detectDrillDownFoldPlan>[0],
    null,
    allowSelfEndpointDrill
  );
}

describe("structural fold detection vs a facet-requeried read-only GET search", () => {
  it("invents a same-endpoint drill when self-endpoint drills are allowed (the default)", () => {
    // Pins the pre-fix behaviour so the guard below is demonstrably load-bearing:
    // with no author intent to distinguish, the detector does pair the two.
    const plans = detectAll(buildFacetRequeriedSearchSteps(), true);

    expect(plans.length).toBeGreaterThan(0);
  });

  it("invents nothing when the flow declared no foldReturn", () => {
    // The fix: a same-endpoint capture can only be a re-query of the search, so
    // it must not become a per-item drill. Without this, recon:generate dies in
    // assertNoFrozenVaryingDrillParams and emits no contract at all.
    const plans = detectAll(buildFacetRequeriedSearchSteps(), false);

    expect(plans).toEqual([]);
  });
});

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");
const HOST = "api.example.com";

function facetSearchCaptures() {
  const facets = [
    "qty=2&region=C&pageNumber=1",
    "qty=3&region=C&pageNumber=1",
    "qty=3&region=A&pageNumber=1",
    "qty=3&region=A&brand=CB&pageNumber=1",
  ];
  return facets.map(
    (query, i) =>
      buildStep(`r${i}`, {
        url: `https://${HOST}/catalog/search?${query}`,
        requestPostData: null,
        method: "GET",
        timestamp: `2026-11-02T12:00:0${i + 1}.000Z`,
        responseBody: {
          results: {
            items: [
              { id: "I1", brandCode: "CB", size: 7, imageUrl: "https://img.example.com/1.png" },
              { id: "I2", brandCode: "VI", size: 5, imageUrl: "https://img.example.com/2.png" },
            ],
          },
        },
      }).capture
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

describe("recon-generate CLI — read-only GET facet search with no declared foldReturn", () => {
  it("generates a single-endpoint read plugin: no self-fold, no response-URL abort", () => {
    workDir = mkdtempSync(join(tmpdir(), "no-foldreturn-get-e2e-"));
    const runRoot = join(workDir, "run");
    for (const d of ["graphql", "replays", "aux"]) mkdirSync(join(runRoot, d), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), "[]");
    for (const [i, c] of facetSearchCaptures().entries()) {
      writeFileSync(
        join(runRoot, "graphql", `${String(i).padStart(3, "0")}-capture.json`),
        JSON.stringify(c)
      );
    }
    const siteId = `no-foldreturn-get-e2e-test-${process.pid}`;
    siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "search the catalog" }],
        submitEndpointPattern: "catalog/search",
        ownBackendHostnames: [HOST],
      })
    );
    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: RECON_GENERATE_CWD, encoding: "utf8" }
    );
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status, output).toBe(0);
    const contract = readFileSync(
      join(RECON_GENERATE_CWD, "src", "sites", siteId, "contract.ts"),
      "utf8"
    );
    expect(output).toContain("single-endpoint REST");
    expect(output).not.toMatch(/unreferenced|frozen|fold plan/i);
    // One GET, no multi-step chain / per-item drill loop.
    expect(contract).toContain('method: "GET"');
    expect(contract.match(/catalog\/search/g)).toHaveLength(1);
    expect(contract).not.toMatch(/foldMatches|for \(const item of/);
    // The response schema's required-looking imageUrl is not a payload input.
    expect(contract).toContain("imageUrl");
    expect(contract).not.toContain("payload.imageUrl");
    // A literal-1 pageNumber facet stays a payload parameter defaulting to "1".
    expect(contract).toContain('String(payload.pageNumber ?? "1")');
  }, 90_000);
});
