import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Locks in required item 3 for the branch selectPrimaryGraphQLOperation
 * never runs: once a mutation capture makes extractGraphQLActionSequence
 * non-empty, generation resolves its readonly query/endpoint/response
 * source through the raw firstGraphQLQuery/firstEndpointPath/
 * firstEndpointCapture fallbacks instead. recon-generate-submitstep-readonly-
 * facet-preference-e2e.test.ts only exercises the gated scorer's facetScore
 * weight (no mutation capture present, so selectPrimaryGraphQLOperation runs
 * normally); this test forces the ungated fallback branch and asserts a
 * chronologically-earlier, more-recurring third-party candidate still loses
 * to the own-backend facet-bearing capture.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_HOST = "shop.example.com";
const THIRD_PARTY_HOST = "flags.thirdparty-sdk.example";
const THIRD_PARTY_PATH = "/msdk/big-segments";

function thirdPartyQueryCapture(index: number): Capture {
  return {
    timestamp: `2026-01-01T00:00:0${index}.000Z`,
    phase: "browse",
    method: "POST",
    url: `https://${THIRD_PARTY_HOST}${THIRD_PARTY_PATH}`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({
      variables: { pagination: { count: 24 }, sort: { by: "category" } },
    }),
    responseHeaders: { "content-type": "application/json" },
    operationName: "catalogSearch_Items",
    query:
      "query catalogSearch_Items($filters: String) { catalogSearch(filters: $filters) { items { id name } } }",
    variables: { pagination: { count: 24 }, sort: { by: "category" } },
    responseBody: {
      catalogSearch: {
        items: Array.from({ length: 100 }, (_, i) => ({ id: `sku-${i}`, name: `Item ${i}` })),
      },
    },
    decodedParams: null,
  };
}

// Chronologically later and appears only once, but is the only capture whose
// `filters` variable spliceFacetsIntoStringVariable can actually land a
// payload facet into.
function ownBackendFacetQueryCapture(): Capture {
  return {
    timestamp: "2026-01-01T00:00:09.000Z",
    phase: "filter-the-catalog",
    method: "POST",
    url: `https://${OWN_HOST}/graphql`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ variables: { filters: "category:kitchen" } }),
    responseHeaders: { "content-type": "application/json" },
    operationName: null,
    query:
      "query catalogSearch_Items($filters: String) { catalogSearch(filters: $filters) { items { id name } } }",
    variables: { filters: "category:kitchen" },
    responseBody: { catalogSearch: { items: [{ id: "sku-1", name: "Item 1" }] } },
    decodedParams: null,
  };
}

// Puts a mutation into the capture set so extractGraphQLActionSequence is
// non-empty, forcing generation off the selectPrimaryGraphQLOperation path
// and onto the raw fallback helpers this test targets.
function ownBackendSubmitMutationCapture(): Capture {
  return {
    timestamp: "2026-01-01T00:00:10.000Z",
    phase: "add-to-cart",
    method: "POST",
    url: `https://${OWN_HOST}/graphql`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ variables: { sku: "sku-1" } }),
    responseHeaders: { "content-type": "application/json" },
    operationName: "addToCart",
    query: "mutation addToCart($sku: String) { addToCart(sku: $sku) { ok } }",
    variables: { sku: "sku-1" },
    responseBody: { addToCart: { ok: true } },
    decodedParams: null,
  };
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate ungated fallback prefers own-backend facet-bearing capture over third-party candidate", () => {
  it("wires the QUERY constant and endpoint from the own-backend facet capture, never the earlier/more-recurrent third-party one", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-fallback-facet-preference-e2e-"));
    const runRoot = join(workDir, "run");
    const capturesDir = join(runRoot, "graphql");
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));

    // Third-party candidate written first (chronologically earliest) and
    // repeated 10x (far higher recurrence) than the single own-backend
    // facet capture -- exactly the ordering/frequency a first-in-array or
    // most-frequent heuristic would get wrong.
    const captures: Capture[] = [
      ...Array.from({ length: 10 }, (_, i) => thirdPartyQueryCapture(i)),
      ownBackendFacetQueryCapture(),
      ownBackendSubmitMutationCapture(),
    ];
    captures.forEach((capture, index) => {
      const filename = `${String(index).padStart(3, "0")}-capture.json`;
      writeFileSync(join(capturesDir, filename), JSON.stringify(capture));
    });

    const siteId = `recon-fallback-facet-preference-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(siteOutDir).not.toBeNull();
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        ownBackendHostnames: [OWN_HOST],
        steps: [{ step: "select 'kitchen' from the Category dropdown", payloadField: "category" }],
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
    expect(contract).toContain("baseUrl}/graphql");
  }, 30_000);
});
