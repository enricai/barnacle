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

const OWN_BACKEND_HOST = "www.click-facet-single-primary-parity-fixture.example.com";

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

function readCaptures(): unknown[] {
  return [restCapture(OWN_FILTERS, 0), restCapture(SIBLING_FILTERS, 1), graphqlCapture(2)];
}

function generate(captures: unknown[], extraFlow: object = {}): string {
  workDir = mkdtempSync(join(tmpdir(), "barnacle-click-facet-single-primary-parity-"));
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

  const siteId = `click-facet-single-primary-parity-test-${process.pid}`;
  siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({
      steps: FLOW_STEPS,
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

describe("recon-generate CLI — click-step facet parity between single-primary and multi-step emission", () => {
  it("threads every declared click facet in the single-primary path as the multi-step path does", () => {
    const single = generate(readCaptures());
    const multi = generate(readCaptures(), {
      steps: [...FLOW_STEPS, { step: "submit the order", submitStep: true }],
    });

    for (const contract of [single, multi]) {
      expect(contract).toContain("payload.categories");
      expect(contract).toContain("payload.sizes");
      expect(contract).not.toContain("SHOES;filterType=category");
      expect(contract).not.toContain("4;filterType=size");
    }
  }, 60_000);
});
