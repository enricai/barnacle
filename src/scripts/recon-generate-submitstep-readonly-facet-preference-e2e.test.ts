import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Locks in required item 3 for the submitStep-declared, mutation-free flow
 * shape covered by recon-generate-graphql-readonly-e2e.test.ts's
 * "flow declares submitStep:true but captures zero mutations" case: when both
 * an own-backend facet-bearing candidate and a larger, more-recurring
 * third-party candidate sharing the same operation shape are present,
 * selection must prefer the own-backend facet-bearing one and the emitted
 * contract.ts must wire the facet payload fields from THAT candidate. Exercises
 * facetScore and the host-provenance gate together in the submitStep-declared
 * path rather than in isolation, since either alone would let the third-party
 * candidate win on size/recurrence.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_HOST = "shop.example.com";
const THIRD_PARTY_HOST = "flags.thirdparty-sdk.example";
const THIRD_PARTY_PATH = "/msdk/big-segments";

const QUERY =
  "query catalogSearch_Items($filters: String) { catalogSearch(filters: $filters) { items { id name } } }";

function gqlCapture(overrides: {
  phase: string;
  url: string;
  operationName: string | null;
  variables: Record<string, unknown> | null;
  responseBody: unknown;
}) {
  return {
    timestamp: "2026-08-20T10:23:03.000Z",
    phase: overrides.phase,
    method: "POST",
    url: overrides.url,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ variables: overrides.variables }),
    responseHeaders: { "content-type": "application/json" },
    responseBody: overrides.responseBody,
    operationName: overrides.operationName,
    query: QUERY,
    variables: overrides.variables,
    decodedParams: null,
  };
}

/**
 * The facet-bearing own-backend candidate: small response, a single
 * capture, operationName-null, whose `filters` string packs both declared
 * facet fields.
 */
function ownBackendFacetCapture() {
  return gqlCapture({
    phase: "filter-the-catalog",
    url: `https://${OWN_HOST}/graphql`,
    operationName: null,
    variables: { filters: "category:kitchen|priceRange:10~50" },
    responseBody: { catalogSearch: { items: [{ id: "sku-1", name: "Item 1" }] } },
  });
}

/**
 * The decoy: same operation shape on a third-party host, mentioning both
 * facet field names ("category" in sort.by, "priceRange" in note) so
 * fieldScore's substring match alone cannot distinguish it from the
 * facet-bearing capture, no populated facet value, a much larger response,
 * and far higher recurrence.
 */
function thirdPartyUnfilteredCapture() {
  return gqlCapture({
    phase: "filter-the-catalog",
    url: `https://${THIRD_PARTY_HOST}${THIRD_PARTY_PATH}`,
    operationName: "catalogSearch_Items",
    variables: { pagination: { count: 24 }, sort: { by: "category" }, note: "priceRange" },
    responseBody: {
      catalogSearch: {
        items: Array.from({ length: 100 }, (_, i) => ({ id: `sku-${i}`, name: `Item ${i}` })),
      },
    },
  });
}

function writeRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));

  // Own-backend capture written first so deriveBaseUrl picks the own host
  // even though the third-party host outnumbers it heavily below.
  writeFileSync(
    join(root, "graphql", "000-filter-the-catalog-own.json"),
    JSON.stringify(ownBackendFacetCapture())
  );
  Array.from({ length: 10 }, (_, i) => i).forEach((i) => {
    writeFileSync(
      join(root, "graphql", `${String(i + 1).padStart(3, "0")}-filter-the-catalog-decoy.json`),
      JSON.stringify(thirdPartyUnfilteredCapture())
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

describe("recon-generate CLI e2e: submitStep-declared read-only flow prefers own-backend facet-bearing capture", () => {
  it("wires the facet payload from the own-backend candidate and never references the third-party candidate", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-submitstep-readonly-facet-preference-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `submitstep-readonly-facet-preference-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);
    mkdirSync(siteOutDir, { recursive: true });

    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        ownBackendHostnames: [OWN_HOST],
        steps: [
          { step: "select 'kitchen' from the Category dropdown", payloadField: "category" },
          {
            step: "select '10~50' from the Price Range dropdown",
            payloadField: "priceRange",
            submitStep: true,
          },
        ],
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    expect(contract).not.toContain(THIRD_PARTY_HOST);
    expect(contract).not.toContain(THIRD_PARTY_PATH);
    expect(contract).toContain(OWN_HOST);

    const executeHttpMatch = contract.match(/async executeHttp\([\s\S]*?\n {2}},\n/);
    expect(executeHttpMatch, contract).not.toBeNull();
    const executeHttpBody = executeHttpMatch?.[0] ?? "";

    // The facet variable/value is wired from the own-backend candidate's
    // filters string, not fabricated on top of the third-party candidate's
    // unfiltered pagination/sort shape.
    expect(executeHttpBody).toContain("payload.category");
    expect(executeHttpBody).toContain("payload.priceRange");
    expect(executeHttpBody).toContain(
      "filters: `category:$" + "{payload.category}|priceRange:$" + "{payload.priceRange}`"
    );
  }, 30_000);
});
