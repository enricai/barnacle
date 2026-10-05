import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Closes the regression gap the defect_scope audit found: every existing
 * array-element facet-splice e2e test (navigateto-array-element-facet-splice,
 * gql-navigateto-array-element-facet-splice, navigateto-cumulative-array-
 * element-facet-splice, navigateto-facet-array-element-threading,
 * recon-generate-array-facet-splice) proves a navigateTo-declared facet
 * literal recurring as a token-bounded substring inside a captured array
 * element threads to `payload.<field>` for its own transport, but NONE of
 * them assert on `optional` — a navigateTo step's `optional` flag flows into
 * `NavigateToFacetBinding.optional` (bugfix-001) and is honored by
 * `spliceFacetsIntoArrayVariable`'s conditional-spread branch (bugfix-003)
 * so an absent optional facet drops its element instead of stringifying to
 * the literal text "undefined". This file proves, end to end through the
 * real `recon:generate` CLI, that the conditional spread actually appears
 * in the emitted call site for an array-element facet marked optional —
 * the same source-level proof convention
 * recon-generate-array-facet-splice-e2e.test.ts's own optional-facet unit
 * test and recon-generate-facet-string-splice-optional-omission.test.ts's
 * sibling (string-variable) optional-facet tests already use, extended
 * here to a real multi-capture CLI run instead of a direct emitContractTs
 * call. It also re-confirms the baseline (non-optional) REST and GraphQL
 * array-element splices from the sibling e2e files still thread correctly,
 * so an optionality fix can never regress the plain case. Uses a generic
 * catalog/inventory domain fixture — no real site or plugin name appears
 * anywhere below.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const REST_HOST = "www.navigateto-array-facet-optional-splice-rest-fixture.example.com";
const GQL_HOST = "www.navigateto-array-facet-optional-splice-gql-fixture.example.com";
const DELIMITER = ";sourceId=urlFriendlyId";

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

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

function generate(siteId: string, runRoot: string): { contract: string } {
  siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
  const result = spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return { contract: readFileSync(join(siteOutDir, "contract.ts"), "utf8") };
}

describe("recon-generate CLI — navigateTo array-facet threading, REST + GraphQL, with optionality", () => {
  it("splices a non-optional navigateTo facet into a REST array element, preserving its constant suffix", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-navigateto-array-facet-optional-rest-"));
    const runRoot = join(workDir, "run");
    const CATEGORY_TOKEN = "catx-rest-array-facet-7731";
    writeRunDir(runRoot, [
      buildCapture({
        url: `https://${REST_HOST}/catalog/browse/`,
        requestPostData: JSON.stringify({ sort: "relevance" }),
        responseBody: { ok: true },
        timestamp: "2026-05-01T00:00:00.000Z",
      }),
      buildCapture({
        url: `https://${REST_HOST}/catalog/filter-results/`,
        requestPostData: JSON.stringify({
          sort: "relevance",
          tags: ["in-stock", `${CATEGORY_TOKEN}${DELIMITER}`, "free-shipping"],
        }),
        responseBody: { ok: true },
        timestamp: "2026-05-01T00:00:01.000Z",
      }),
    ]);

    const siteId = `navigateto-array-facet-optional-splice-rest-test-${process.pid}`;
    mkdirSync(join(REPO_ROOT, "src", "sites", siteId), { recursive: true });
    writeFileSync(
      join(REPO_ROOT, "src", "sites", siteId, "recon-flow.json"),
      JSON.stringify({
        steps: [
          {
            step: "navigate to the catalog with the category facet applied",
            navigateTo: `https://${REST_HOST}/#/catalog/${CATEGORY_TOKEN}`,
            payloadField: "CategoryFacet",
          },
          { step: "browse catalog" },
        ],
        ownBackendHostnames: [REST_HOST],
      })
    );

    const { contract } = generate(siteId, runRoot);

    expect(contract).toContain(`\${payload.CategoryFacet}${DELIMITER}`);
    expect(contract).not.toContain(CATEGORY_TOKEN);
  }, 30_000);

  it("splices a non-optional navigateTo facet into a GraphQL array-valued variable element", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-navigateto-array-facet-optional-gql-"));
    const runRoot = join(workDir, "run");
    const BRAND_TOKEN = "brandx-gql-array-facet-4420";
    const filtersArray = [`${BRAND_TOKEN}${DELIMITER}`, "evergreen-item"];
    mkdirSync(join(runRoot, "graphql"), { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
    writeFileSync(
      join(runRoot, "graphql", "000-search-action.json"),
      JSON.stringify({
        timestamp: "2026-05-01T00:00:00.000Z",
        phase: "search",
        method: "POST",
        url: `https://${GQL_HOST}/graphql`,
        status: 200,
        requestHeaders: { "Content-Type": "application/json" },
        requestPostData: JSON.stringify({
          variables: { sort: { by: "RECOMMENDED" }, filters: filtersArray },
        }),
        responseHeaders: { "content-type": "application/json" },
        responseBody: { products: [{ id: "abc" }] },
        operationName: "catalogSearch_Products",
        query:
          "query catalogSearch_Products($sort: SortInput, $filters: [String!]) { products(sort: $sort, filters: $filters) { id } }",
        variables: { sort: { by: "RECOMMENDED" }, filters: filtersArray },
        decodedParams: null,
      })
    );

    const siteId = `navigateto-array-facet-optional-splice-gql-test-${process.pid}`;
    mkdirSync(join(REPO_ROOT, "src", "sites", siteId), { recursive: true });
    writeFileSync(
      join(REPO_ROOT, "src", "sites", siteId, "recon-flow.json"),
      JSON.stringify({
        steps: [
          {
            step: "navigate to the catalog with the brand facet applied",
            navigateTo: `https://${GQL_HOST}/#/catalog/${BRAND_TOKEN}`,
            payloadField: "BrandFacet",
          },
          { step: "browse catalog" },
        ],
        ownBackendHostnames: [GQL_HOST],
      })
    );

    const { contract } = generate(siteId, runRoot);

    expect(contract).toContain(`\`\${payload.BrandFacet}${DELIMITER}\``);
    expect(contract).not.toContain(BRAND_TOKEN);
  }, 30_000);

  it('emits a conditional-spread element for an optional navigateTo facet in a GraphQL array variable, never a literal "undefined" when the caller omits it', () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-navigateto-array-facet-optional-gql-drop-"));
    const runRoot = join(workDir, "run");
    const SIZE_TOKEN = "sizex-gql-optional-array-facet-5510";
    const filtersArray = [`${SIZE_TOKEN}${DELIMITER}`, "evergreen-item"];
    mkdirSync(join(runRoot, "graphql"), { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
    writeFileSync(
      join(runRoot, "graphql", "000-search-action.json"),
      JSON.stringify({
        timestamp: "2026-05-01T00:00:00.000Z",
        phase: "search",
        method: "POST",
        url: `https://${GQL_HOST}/graphql`,
        status: 200,
        requestHeaders: { "Content-Type": "application/json" },
        requestPostData: JSON.stringify({
          variables: { sort: { by: "RECOMMENDED" }, filters: filtersArray },
        }),
        responseHeaders: { "content-type": "application/json" },
        responseBody: { products: [{ id: "abc" }] },
        operationName: "catalogSearch_Products",
        query:
          "query catalogSearch_Products($sort: SortInput, $filters: [String!]) { products(sort: $sort, filters: $filters) { id } }",
        variables: { sort: { by: "RECOMMENDED" }, filters: filtersArray },
        decodedParams: null,
      })
    );

    const siteId = `navigateto-array-facet-optional-splice-gql-drop-test-${process.pid}`;
    mkdirSync(join(REPO_ROOT, "src", "sites", siteId), { recursive: true });
    writeFileSync(
      join(REPO_ROOT, "src", "sites", siteId, "recon-flow.json"),
      JSON.stringify({
        steps: [
          {
            step: "navigate to the catalog with the size facet applied",
            navigateTo: `https://${GQL_HOST}/#/catalog/${SIZE_TOKEN}`,
            payloadField: "SizeFacet",
            optional: true,
          },
          { step: "browse catalog" },
        ],
        ownBackendHostnames: [GQL_HOST],
      })
    );

    const { contract } = generate(siteId, runRoot);

    // Source-level: the conditional-spread convention — matching the one
    // recon-generate-array-facet-splice-e2e.test.ts's own optional-facet
    // unit test pins directly against emitContractTs — not an unconditional
    // element that would stringify `payload.SizeFacet` to "undefined" when
    // the caller omits it.
    expect(contract).toContain(
      `...(payload.SizeFacet ? [\`\${payload.SizeFacet}${DELIMITER}\`] : [])`
    );
    expect(contract).not.toContain("undefined");
  }, 30_000);

  it("still threads a REST array-element facet correctly when its navigateTo step is marked optional and the caller DOES supply it", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-navigateto-array-facet-optional-rest-present-"));
    const runRoot = join(workDir, "run");
    const FIT_TOKEN = "fitx-rest-optional-array-facet-2290";
    writeRunDir(runRoot, [
      buildCapture({
        url: `https://${REST_HOST}/catalog/browse/`,
        requestPostData: JSON.stringify({ sort: "relevance" }),
        responseBody: { ok: true },
        timestamp: "2026-06-01T00:00:00.000Z",
      }),
      buildCapture({
        url: `https://${REST_HOST}/catalog/filter-results/`,
        requestPostData: JSON.stringify({
          sort: "relevance",
          tags: ["in-stock", `${FIT_TOKEN}${DELIMITER}`, "free-shipping"],
        }),
        responseBody: { ok: true },
        timestamp: "2026-06-01T00:00:01.000Z",
      }),
    ]);

    const siteId = `navigateto-array-facet-optional-splice-rest-present-test-${process.pid}`;
    mkdirSync(join(REPO_ROOT, "src", "sites", siteId), { recursive: true });
    writeFileSync(
      join(REPO_ROOT, "src", "sites", siteId, "recon-flow.json"),
      JSON.stringify({
        steps: [
          {
            step: "navigate to the catalog with the fit facet applied",
            navigateTo: `https://${REST_HOST}/#/catalog/${FIT_TOKEN}`,
            payloadField: "FitFacet",
            optional: true,
          },
          { step: "browse catalog" },
        ],
        ownBackendHostnames: [REST_HOST],
      })
    );

    const { contract } = generate(siteId, runRoot);

    expect(contract).toContain(`\${payload.FitFacet}${DELIMITER}`);
    expect(contract).not.toContain(FIT_TOKEN);

    // The explicit payloadField annotation is always required at the schema
    // level regardless of the navigateTo step's own optional (execution-skip)
    // flag — see recon-generate.payloadfield-optional-step-required-schema-
    // regression.test.ts. Re-asserted here so a future change to that
    // established contract can't silently regress through this file.
    expect(contract).toMatch(/FitFacet:\s*z\.string\(\)(?!\.optional)/);
  }, 30_000);
});
