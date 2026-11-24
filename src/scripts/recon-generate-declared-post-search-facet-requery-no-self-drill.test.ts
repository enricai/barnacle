import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectDrillDownFoldPlan } from "@/scripts/recon-generate";
import { RECON_GENERATE_CWD } from "@/scripts/recon-generate-cwd.test-helper";
import { buildStep, type MulticallFixtureStep } from "@/scripts/recon-generate-multicall-fixture";

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");
const HOST = "example.test";
const SEARCH_URL = `https://${HOST}/caps/pricing/v1/cruises`;
const DRILL_URL = `https://${HOST}/caps/pricing/v1/cruises/detail`;

const BASE_BOOKING = {
  bookingAgency: { id: "DIRPB" },
  currencyCode: "USD",
  guests: [{ country: "US", homeCity: "LAX" }],
  couponCodes: [],
};

function searchBody(filters: Record<string, unknown>): string {
  return JSON.stringify({ booking: BASE_BOOKING, filters, leadInBy: "itins" });
}

/** Two bodies differing in filter arrays; items carry the facet values ("I", "G", "C"). */
const BODY_A = searchBody({ availabilities: ["Y", "G", "B"], cruiseType: "C", meta: "I" });
const BODY_B = searchBody({ availabilities: ["B"], cruiseType: "C", meta: "B", trades: ["C"] });

function searchResponse(extra: string) {
  return {
    sailings: [
      { voyageId: "V1", meta: "I", availability: "G", trade: "C", tag: extra },
      { voyageId: "V2", meta: "B", availability: "B", trade: "C", tag: extra },
    ],
  };
}

function search(id: string, body: string, ts: string, extra: string): MulticallFixtureStep {
  return buildStep(id, {
    url: SEARCH_URL,
    requestPostData: body,
    method: "POST",
    timestamp: ts,
    responseBody: searchResponse(extra),
  });
}

function drill(): MulticallFixtureStep {
  return buildStep("d1", {
    url: DRILL_URL,
    requestPostData: JSON.stringify({ voyageId: "V1" }),
    method: "POST",
    timestamp: "2026-11-02T12:00:09.000Z",
    responseBody: { cabins: [{ code: "IN", price: 100 }] },
  });
}

const searches = () => [
  search("s1", BODY_A, "2026-11-02T12:00:01.000Z", "one"),
  search("s2", BODY_B, "2026-11-02T12:00:02.000Z", "two"),
  search("s3", BODY_A, "2026-11-02T12:00:03.000Z", "three"),
];

const isDeclaredSubmit = (c: { url: string }) =>
  c.url.includes("/cruises") && !c.url.includes("detail");

function detect(
  steps: MulticallFixtureStep[],
  policy: Parameters<typeof detectDrillDownFoldPlan>[2]
) {
  return detectDrillDownFoldPlan(
    steps as unknown as Parameters<typeof detectDrillDownFoldPlan>[0],
    null,
    policy
  );
}

describe("detectDrillDownFoldPlan with a declared-submit matcher", () => {
  it("yields no self-endpoint drill for declared-submit search re-queries", () => {
    const plans = detect(searches(), isDeclaredSubmit as never);
    expect(plans).toEqual([]);
  });

  it("still permits a genuine different-endpoint drill beside the search", () => {
    const plans = detect([...searches(), drill()], isDeclaredSubmit as never);
    expect(plans.length).toBeGreaterThan(0);
    expect(plans.flatMap((p) => p.targets.map((t) => t.drillStepIndex))).toEqual([3]);
  });

  it("without the matcher (allow all) the structural self-drill is still found", () => {
    expect(detect(searches(), true).length).toBeGreaterThan(0);
  });
});

let workDir: string | null = null;
let siteOutDir: string | null = null;
afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

function runGenerate(steps: MulticallFixtureStep[], flow: Record<string, unknown>) {
  workDir = mkdtempSync(join(tmpdir(), "declared-post-search-facet-"));
  const runRoot = join(workDir, "run");
  for (const d of ["graphql", "replays", "aux"]) mkdirSync(join(runRoot, d), { recursive: true });
  writeFileSync(join(runRoot, "replays", "rate-limit.json"), "[]");
  steps.forEach((s, i) => {
    writeFileSync(
      join(runRoot, "graphql", `${String(i).padStart(3, "0")}-capture.json`),
      JSON.stringify(s.capture)
    );
  });
  const siteId = `declared-post-search-facet-test-${process.pid}`;
  siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({ ownBackendHostnames: [HOST], ...flow })
  );
  const result = spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
    { cwd: RECON_GENERATE_CWD, encoding: "utf8" }
  );
  const output = `${result.stdout}\n${result.stderr}`;
  const contractPath = join(siteOutDir, "contract.ts");
  let contract = "";
  try {
    contract = readFileSync(contractPath, "utf8");
  } catch {}
  return { result, output, contract };
}

describe("recon-generate CLI — declared submit pattern + foldReturn with a POST facet search", () => {
  it("does not throw the frozen-varying error and emits the search once, plus the real drill", () => {
    const { result, output, contract } = runGenerate([...searches(), drill()], {
      steps: [{ step: "search sailings", submitStep: true }],
      submitEndpointPattern: "pricing/v1/cruises$",
      foldReturn: {
        endpointPattern: "cruises/detail",
        resultsPath: "sailings",
        drillResultsPath: "cabins",
        joinFields: ["voyageId"],
      },
    });
    expect(output).not.toMatch(/would freeze a value that varied/);
    expect(output).not.toMatch(/frozen/i);
    expect(result.status, output).toBe(0);
    // One search action (payload variants), one genuine different-endpoint drill.
    // The per-item fold loop drills the different endpoint, never the search itself.
    const loopBody = contract.slice(contract.indexOf("foldItems).map"));
    expect(loopBody).toContain("pricing/v1/cruises/detail");
    expect(loopBody).not.toMatch(/pricing\/v1\/cruises`/);
    expect(contract).toContain("cruises/detail");
    expect(contract).toContain("voyageId");
  }, 90_000);

  it("a declared self-fold on the search endpoint still resolves", () => {
    const { result, output, contract } = runGenerate(searches(), {
      steps: [{ step: "search sailings", submitStep: true }],
      submitEndpointPattern: "pricing/v1/cruises",
      foldReturn: {
        endpointPattern: "pricing/v1/cruises",
        resultsPath: "sailings",
        joinFields: ["voyageId"],
      },
    });
    expect(output).not.toMatch(/would freeze a value that varied/);
    expect(result.status, output).toBe(0);
    expect(contract).toContain("foldMatch");
  }, 90_000);
});
