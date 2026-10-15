import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { harvestPersonaBindings } from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

/**
 * A click-step facet must be threaded identically by the REST body splice, the
 * GraphQL variables splice and the persona-binding harvest, so no transport
 * drops a facet another one threads.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.click-facet-transport-parity-fixture.example.com";

const CATEGORY_STEP =
  "Open the category filter dropdown in the catalogue toolbar and select the 'Shoes' category option";
const SIZE_STEP =
  "Open the size (number of units) filter dropdown in the catalogue toolbar and select the '4' size option";

const FLOW_STEPS = [
  {
    step: "navigate to the gadgets section page",
    navigateTo: `https://${OWN_BACKEND_HOST}/#/browse/gadgets`,
    payloadField: "section",
  },
  { step: CATEGORY_STEP, payloadField: "categories" },
  { step: SIZE_STEP, payloadField: "sizes" },
  { step: "submit the order", submitStep: true },
];

const OWN_FILTERS = ["2026-12;filterType=date", "SHOES;filterType=category"];
const SIBLING_FILTERS = [
  "2026-12;filterType=date",
  "4;filterType=size",
  "SHOES;filterType=category",
];
const GQL_FILTERS = ["2026-12;filterType=date", "SHOES;filterType=category", "4;filterType=size"];

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

function restCapture(filters: string[], second: number): unknown {
  return buildCapture({
    url: `https://${OWN_BACKEND_HOST}/catalogue/`,
    requestPostData: JSON.stringify({ section: "gadgets", pageSize: 20, filters }),
    responseBody: { ok: true },
    timestamp: `2026-01-01T00:00:0${second}.000Z`,
  });
}

function graphqlCapture(second: number): unknown {
  const variables = { sort: "RELEVANCE", filters: GQL_FILTERS };
  return {
    ...buildCapture({
      url: `https://${OWN_BACKEND_HOST}/graphql`,
      requestPostData: JSON.stringify({ variables }),
      responseBody: { trips: [{ id: "abc" }] },
      timestamp: `2026-01-01T00:00:0${second}.000Z`,
    }),
    operationName: "tripSearch",
    query:
      "query tripSearch($sort: String, $filters: [String!]) { trips(sort: $sort, filters: $filters) { id } }",
    variables,
  };
}

function transportCaptures(): unknown[] {
  return [
    restCapture(OWN_FILTERS, 0),
    restCapture(SIBLING_FILTERS, 1),
    graphqlCapture(2),
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/submit/`,
      requestPostData: JSON.stringify({ confirm: true }),
      responseBody: { ok: true },
      timestamp: "2026-01-01T00:00:03.000Z",
    }),
  ];
}

function foldCaptures(): unknown[] {
  const shapes = [OWN_FILTERS, SIBLING_FILTERS];
  return [
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/catalog/search/`,
      requestPostData: JSON.stringify({ page: 1 }),
      responseBody: { results: shapes.map((_, index) => ({ sku: `sku-${index}` })) },
      timestamp: "2026-06-01T00:00:00.000Z",
    }),
    ...shapes.map((filters, index) =>
      buildCapture({
        url: `https://${OWN_BACKEND_HOST}/catalog/pricing/?sku=sku-${index}&shape${filters.length}=ok`,
        requestPostData: JSON.stringify({ filters }),
        responseBody: { results: [{ sku: `sku-${index}`, amount: 19.99 }] },
        timestamp: `2026-06-01T00:00:0${index + 1}.000Z`,
      })
    ),
  ];
}

function generate(captures: unknown[], extraFlow: object = {}): string {
  workDir = mkdtempSync(join(tmpdir(), "barnacle-click-facet-transport-parity-"));
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

  const siteId = `click-facet-transport-parity-test-${process.pid}`;
  siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({
      steps: FLOW_STEPS,
      submitEndpointPattern: "submit",
      requireSubmitEndpointMatch: true,
      ownBackendHostnames: [OWN_BACKEND_HOST],
      ...extraFlow,
    })
  );

  const result = spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return readFileSync(join(siteOutDir, "contract.ts"), "utf8");
}

describe("recon-generate CLI — click-step facet parity across REST, GraphQL and bindings", () => {
  it("threads the same click facets on every transport and drops none", () => {
    const contract = generate(transportCaptures());

    expect(
      contract.match(/payload\.categories[^`]*;filterType=category/g)?.length
    ).toBeGreaterThanOrEqual(2);
    expect(contract.match(/payload\.sizes[^`]*;filterType=size/g)?.length).toBeGreaterThanOrEqual(
      2
    );
    expect(contract).not.toContain("SHOES;filterType=category");
    expect(contract).not.toContain("4;filterType=size");

    const bindings = harvestPersonaBindings(FLOW_STEPS as never, { exclusions: [] } as never, {});
    expect(bindings.get("Shoes")).toBe("payload.categories");
    expect(bindings.get("4")).toBe("payload.sizes");
  }, 30_000);

  it("places an element missing from the own capture where its sibling capture carries it", () => {
    const contract = generate(foldCaptures(), {
      submitEndpointPattern: "catalog/pricing",
      foldReturn: {
        endpointPattern: "catalog/pricing",
        resultsPath: "results",
        joinFields: ["sku"],
      },
    });
    const body = contract.split("\n").find((line) => line.includes('body: `{"filters"'));

    expect(body, contract).toBeDefined();
    const date = (body as string).indexOf("2026-12;filterType=date");
    const size = (body as string).indexOf("payload.sizes");
    const category = (body as string).indexOf("payload.categories");
    expect(date).toBeGreaterThan(-1);
    expect(size).toBeGreaterThan(date);
    expect(category).toBeGreaterThan(size);
  }, 60_000);
});
