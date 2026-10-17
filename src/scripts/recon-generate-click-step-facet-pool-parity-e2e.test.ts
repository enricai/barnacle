import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

/**
 * The multi-step REST, single-primary REST and GraphQL emissions resolve facets
 * from different capture pools, so the same mixed-vocabulary captures must still
 * bind the same facet set on each, including when the kind-suffixed request is
 * not the compiled submit step.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.click-facet-pool-parity-fixture.example.com";

const CATEGORY_STEP =
  "Open the category filter dropdown in the catalogue toolbar and select the 'Shoes' category option";
const SIZE_STEP =
  "Open the size (number of units) filter dropdown in the catalogue toolbar and select the '4' size option";

const CLICK_STEPS = [
  {
    step: "navigate to the gadgets section page",
    navigateTo: `https://${OWN_BACKEND_HOST}/#/browse/gadgets`,
    payloadField: "section",
  },
  { step: CATEGORY_STEP, payloadField: "categories" },
  { step: SIZE_STEP, payloadField: "sizes" },
];

const FILTERS = ["2026-12;filterType=date", "SHOES;filterType=category", "4;filterType=size"];
const FACET_REF = /payload\.(section|categories|sizes)\b/g;

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

function restCapture(): unknown {
  return buildCapture({
    url: `https://${OWN_BACKEND_HOST}/catalogue/`,
    requestPostData: JSON.stringify({ section: "gadgets", pageSize: 20, filters: FILTERS }),
    responseBody: { ok: true },
    timestamp: "2026-01-01T00:00:00.000Z",
  });
}

function graphqlCapture(): unknown {
  const variables = { sort: "RELEVANCE", filters: FILTERS };
  return {
    ...buildCapture({
      url: `https://${OWN_BACKEND_HOST}/graphql`,
      requestPostData: JSON.stringify({ variables }),
      responseBody: { trips: [{ id: "abc" }] },
      timestamp: "2026-01-01T00:00:01.000Z",
    }),
    operationName: "tripSearch",
    query:
      "query tripSearch($sort: String, $filters: [String!]) { trips(sort: $sort, filters: $filters) { id } }",
    variables,
  };
}

function submitCapture(): unknown {
  return buildCapture({
    url: `https://${OWN_BACKEND_HOST}/submit/`,
    requestPostData: JSON.stringify({ confirm: true }),
    responseBody: { ok: true },
    timestamp: "2026-01-01T00:00:02.000Z",
  });
}

function generate(captures: unknown[], flow: object): string {
  workDir = mkdtempSync(join(tmpdir(), "barnacle-click-facet-pool-parity-"));
  const runRoot = join(workDir, "run");
  mkdirSync(join(runRoot, "graphql"), { recursive: true });
  mkdirSync(join(runRoot, "replays"), { recursive: true });
  mkdirSync(join(runRoot, "aux"), { recursive: true });
  writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
  captures.forEach((capture, index) => {
    writeFileSync(
      join(runRoot, "graphql", `${String(index).padStart(3, "0")}-capture.json`),
      JSON.stringify(capture)
    );
  });

  const siteId = `click-facet-pool-parity-test-${process.pid}`;
  siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({ ownBackendHostnames: [OWN_BACKEND_HOST], ...flow })
  );

  const result = spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return readFileSync(join(siteOutDir, "contract.ts"), "utf8");
}

function facetRefs(contract: string): string[] {
  return [...new Set(contract.match(FACET_REF) ?? [])].sort();
}

function splicedKinds(contract: string): string[] {
  return ["category", "size"].filter((kind) =>
    new RegExp(`payload\\.\\w+[^\`]*;filterType=${kind}`).test(contract)
  );
}

describe("recon-generate CLI — click-step facet pool parity across transports", () => {
  it("binds the same facets on multi-step, single-primary and GraphQL emissions", () => {
    const multi = generate([restCapture(), submitCapture()], {
      steps: [...CLICK_STEPS, { step: "submit the order", submitStep: true }],
      submitEndpointPattern: "submit",
      requireSubmitEndpointMatch: true,
    });
    const single = generate([restCapture()], { steps: CLICK_STEPS });
    const gql = generate([graphqlCapture()], { steps: CLICK_STEPS });

    const expected = ["payload.categories", "payload.section", "payload.sizes"];
    expect(facetRefs(single), single).toEqual(expected);
    expect(facetRefs(gql), gql).toEqual(expected);
    expect(facetRefs(multi), multi).toEqual(expected);

    for (const contract of [multi, single, gql]) {
      expect(splicedKinds(contract), contract).toEqual(["category", "size"]);
      expect(contract).not.toContain("SHOES;filterType=category");
      expect(contract).not.toContain("4;filterType=size");
    }
  }, 90_000);

  it("keeps the facet set when the kind-suffixed request is not the compiled action step", () => {
    const captures = [restCapture(), graphqlCapture(), submitCapture()];
    const multi = generate(captures, {
      steps: [...CLICK_STEPS, { step: "submit the order", submitStep: true }],
      submitEndpointPattern: "submit",
      requireSubmitEndpointMatch: true,
    });
    const gqlOnly = generate([graphqlCapture()], { steps: CLICK_STEPS });

    expect(facetRefs(multi), multi).toEqual(facetRefs(gqlOnly));
    expect(splicedKinds(multi), multi).toEqual(splicedKinds(gqlOnly));
  }, 60_000);
});
