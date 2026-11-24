import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type FoldReturnSpec,
  findFrozenVaryingDrillParams,
  resolveFoldPlan,
} from "@/scripts/recon-generate";
import { RECON_GENERATE_CWD } from "@/scripts/recon-generate-cwd.test-helper";
import { buildStep, type MulticallFixtureStep } from "@/scripts/recon-generate-multicall-fixture";

/**
 * A read-only POST search re-queried with different JSON filter bodies, in a
 * flow that ALSO declares a foldReturn drill — but on a DIFFERENT GET endpoint
 * (`catalog/detail`). The declared drill must not re-enable same-endpoint
 * pairing: the filter re-queries of the search stay one search whose filters
 * are payload inputs.
 *
 * The search items carry `code` values that the re-query bodies echo as
 * `brandCode`/`size`, which is what makes the structural detector pair them.
 */
const HOST = "api.example.com";
const SEARCH_URL = `https://${HOST}/catalog/search`;
const DETAIL_URL = `https://${HOST}/catalog/detail`;

const listing = (suffix: string) => ({
  results: {
    items: [
      { id: `I1${suffix}`, brandCode: "AA", size: 7 },
      { id: `I2${suffix}`, brandCode: "BB", size: 5 },
    ],
  },
});

function search(i: number, body: Record<string, unknown>, suffix: string): MulticallFixtureStep {
  return buildStep(`r${i}`, {
    url: SEARCH_URL,
    requestPostData: JSON.stringify(body),
    method: "POST",
    timestamp: `2026-11-02T12:00:0${i + 1}.000Z`,
    responseBody: listing(suffix),
  });
}

function buildSteps(): MulticallFixtureStep[] {
  return [
    search(0, { qty: 2, region: "C" }, "a"),
    search(1, { qty: 3, region: "A" }, "b"),
    // Facet re-query echoing codes from the first listing's own items.
    search(2, { qty: 3, region: "A", brandCode: "AA", size: 7 }, "c"),
    buildStep("r3", {
      url: `${DETAIL_URL}?id=I1a`,
      requestPostData: null,
      method: "GET",
      timestamp: "2026-11-02T12:00:09.000Z",
      responseBody: { detail: { id: "I1a", price: 5 } },
    }),
  ];
}

const detailSpec: FoldReturnSpec = {
  endpointPattern: "catalog/detail",
  resultsPath: "results.items",
  joinFields: ["id"],
};

type FoldSteps = Parameters<typeof resolveFoldPlan>[0];
const asSteps = (s: MulticallFixtureStep[]) => s as unknown as FoldSteps;
const searchKey = "catalog/search";

describe("declared foldReturn for another endpoint vs a faceted POST search", () => {
  it("builds no plan that drills the search endpoint into itself", () => {
    const steps = buildSteps();
    const plans = resolveFoldPlan(asSteps(steps), detailSpec);
    for (const plan of plans) {
      for (const t of plan.targets) {
        const ids = [t.drillStepIndex, t.chainTerminalIndex];
        for (const idx of ids) expect(steps[idx]!.capture.url).not.toContain(searchKey);
      }
      expect(plan.absorbedIndices.map((i) => steps[i]!.capture.url)).not.toContain(SEARCH_URL);
    }
  });

  it("reports no frozen varying params for the search re-queries", () => {
    const captures = buildSteps()
      .slice(0, 3)
      .map((s) => s.capture);
    const frozen = findFrozenVaryingDrillParams(captures[2]!, "{}", captures);
    expect(frozen).toEqual([]);
  });

  it("a declared same-endpoint fold still resolves", () => {
    const plans = resolveFoldPlan(asSteps(buildSteps()), {
      endpointPattern: "catalog/search",
      resultsPath: "results.items",
      joinFields: ["id"],
    });
    expect(plans.length).toBeGreaterThan(0);
    expect(plans[0]!.primaryArrayPath).toEqual(["results", "items"]);
  });
});

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

let workDir: string | null = null;
let siteOutDir: string | null = null;
afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate CLI — faceted POST search with a declared foldReturn elsewhere", () => {
  it("does not abort with the frozen-value error", () => {
    workDir = mkdtempSync(join(tmpdir(), "post-search-foldreturn-e2e-"));
    const runRoot = join(workDir, "run");
    for (const d of ["graphql", "replays", "aux"]) mkdirSync(join(runRoot, d), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), "[]");
    for (const [i, s] of buildSteps().entries()) {
      writeFileSync(
        join(runRoot, "graphql", `${String(i).padStart(3, "0")}-capture.json`),
        JSON.stringify(s.capture)
      );
    }
    const siteId = `post-search-foldreturn-e2e-test-${process.pid}`;
    siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "search the catalog" }],
        submitEndpointPattern: "catalog/search",
        ownBackendHostnames: [HOST],
        foldReturn: detailSpec,
      })
    );
    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: RECON_GENERATE_CWD, encoding: "utf8" }
    );
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).not.toMatch(/frozen/i);
    expect(result.status, output).toBe(0);
    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contract).toBeTruthy();
  }, 90_000);
});
