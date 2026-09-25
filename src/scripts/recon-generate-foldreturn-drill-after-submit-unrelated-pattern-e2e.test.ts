import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildStep } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Regression for a declared `foldReturn` whose drill-down fires AFTER the
 * flow's terminal submit call and whose endpoint name shares nothing with the
 * declared `submitEndpointPattern`. The sibling e2e
 * (`recon-generate-foldreturn-drilldown-onto-authoritative-submit-chain-e2e`)
 * only kept its fold target because its submit pattern happened to match the
 * fold target's URL too; here it deliberately does not, so the truncation
 * boundary must be extended by the declared spec itself
 * (`truncateActionSequenceAtSubmitPattern`'s `foldReturnSpec` parameter).
 * Before the fix the drill was truncated away, `buildFoldPlanFromSpec`
 * resolved nothing, and only the structural currency/taxIncluded guess for an
 * earlier drill was emitted — silently, since a structural plan still counted
 * as "a fold plan resolved".
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.own-backend-post-submit-drill-fixture.example.com";
const BASE = `https://${OWN_BACKEND_HOST}`;

function captures(): Capture[] {
  return [
    buildStep("r0", {
      url: `${BASE}/listings-avail-api/authz/private`,
      requestPostData: "{}",
      responseBody: { result: "anonymous", successful: true },
      timestamp: "2024-01-01T00:00:00Z",
    }),
    buildStep("r1", {
      url: `${BASE}/listings-avail-api/available-products/`,
      requestPostData: JSON.stringify({ category: "lofts", page: 1, currency: "USD" }),
      responseBody: {
        totalPages: 1,
        products: [
          {
            productId: "p1",
            units: [
              { unitId: "s1", priceSummary: { currency: "USD", taxIncluded: true } },
              { unitId: "s2", priceSummary: { currency: "USD", taxIncluded: true } },
            ],
          },
        ],
      },
      timestamp: "2024-01-01T00:00:01Z",
    }),
    buildStep("r2", {
      url: `${BASE}/listings-avail-api/available-units/`,
      requestPostData: JSON.stringify({ productId: "p1", currency: "USD", taxIncluded: true }),
      responseBody: {
        units: [
          { unitId: "s1", deck: 7 },
          { unitId: "s2", deck: 8 },
        ],
        exchangeRate: 1.0,
      },
      timestamp: "2024-01-01T00:00:02Z",
    }),
    buildStep("r3", {
      url: `${BASE}/detail-avail-api/unit-detail-availability/s1`,
      requestPostData: JSON.stringify({ unitId: "s1", currency: "USD" }),
      responseBody: { unitDetail: { unitId: "s1", cabinCount: 12 } },
      timestamp: "2024-01-01T00:00:03Z",
    }),
  ].map((step) => step.capture);
}

function writeRunDir(root: string, all: Capture[]): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));
  all.forEach((capture, index) => {
    writeFileSync(
      join(root, "graphql", `${String(index).padStart(3, "0")}-capture.json`),
      JSON.stringify(capture)
    );
  });
}

/** A recon-browser-style manifest naming only submit-pattern matches, padded
 * with a re-fired submit so it out-counts the heuristic chain and would win
 * selection on length alone. */
function writeSubmitManifest(root: string, all: Capture[], indices: number[]): void {
  writeFileSync(
    join(root, "submit-manifest.json"),
    JSON.stringify(
      indices.map((index) => ({
        index,
        filename: `${String(index).padStart(3, "0")}-capture.json`,
        url: all[index]!.url,
      }))
    )
  );
}

function writeFlow(siteOutDir: string): void {
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({
      steps: [
        { step: "authorize session" },
        { step: "browse product listing" },
        { step: "show unit dates", submitStep: true },
        { step: "open one unit's detail" },
      ],
      submitEndpointPattern: "available-units",
      requireSubmitEndpointMatch: true,
      ownBackendHostnames: [OWN_BACKEND_HOST],
      foldReturn: {
        endpointPattern: "unit-detail-availability",
        resultsPath: "products.*.units",
        drillResultsPath: "unitDetail",
        joinFields: ["unitId"],
      },
    })
  );
}

function runGenerate(siteId: string, runRoot: string): { output: string; contract: string } {
  const result = spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return {
    output: `${result.stdout}\n${result.stderr}`,
    contract: readFileSync(join(REPO_ROOT, "src", "sites", siteId, "contract.ts"), "utf8"),
  };
}

function expectDeclaredFoldEmitted(output: string, contract: string): void {
  expect(output).not.toContain("no fold plan resolved");
  expect(output).not.toContain("declared spec resolved no fold plan");
  expect(contract).toContain("unit-detail-availability");
  // The declared join field, not the structural currency/taxIncluded guess.
  expect(contract).toContain('String(m["unitId"]) === String(item.unitId)');
  expect(contract).not.toContain('m["taxIncluded"]');
  // `drillResultsPath` names a flat object: plan resolution treats it as a
  // one-item collection, so the emitted match must wrap it the same way
  // instead of calling `.find` on a plain object at runtime.
  expect(contract).toContain(
    "const foldMatches = [(r3 as { unitDetail: Record<string, unknown> }).unitDetail];"
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

describe("recon-generate CLI — declared foldReturn drill after the submit step, with an endpoint the submitEndpointPattern does not match", () => {
  it("keeps the declared drill past the submit boundary and joins on the declared field", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-foldreturn-post-submit-drill-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, captures());

    const siteId = `foldreturn-post-submit-drill-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFlow(siteOutDir);

    const { output, contract } = runGenerate(siteId, runRoot);
    expectDeclaredFoldEmitted(output, contract);
  }, 60_000);

  it("still keeps the declared drill when a submit-only manifest out-counts the heuristic chain", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-foldreturn-post-submit-drill-manifest-e2e-"));
    const runRoot = join(workDir, "run");
    const all = captures();
    writeRunDir(runRoot, all);
    // Four entries (the submit re-fired) against a four-capture heuristic
    // chain: on length alone the manifest would be trusted and the drill
    // it never recorded would be dropped again.
    writeSubmitManifest(runRoot, all, [0, 1, 2, 2]);

    const siteId = `foldreturn-post-submit-drill-manifest-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFlow(siteOutDir);

    const { output, contract } = runGenerate(siteId, runRoot);
    const rejection = output.match(
      /ignoring submit-manifest\.json \((\d+) capture\(s\)\) because it lacks the declared foldReturn drill-down .* heuristic action sequence \((\d+) capture\(s\)\)/
    );
    expect(rejection, output).not.toBeNull();
    // The falsifier condition: on the length rule alone the manifest wins.
    expect(Number(rejection![1])).toBeGreaterThanOrEqual(Number(rejection![2]));
    expectDeclaredFoldEmitted(output, contract);
  }, 60_000);
});
