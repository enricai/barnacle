import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

/**
 * A click step whose payloadField differs from its element kind (`regions` vs
 * `;filterType=region`) must thread into the kind-suffixed array identically on
 * multi-step REST, single-primary REST and GraphQL, even though the array is
 * not on the compiled submit step.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.click-facet-kind-mismatch-parity-fixture.example.com";

const REGION_STEP =
  "Open the region filter dropdown in the catalogue toolbar and select the 'Alps' region option";
const SIZE_STEP =
  "Open the size (number of units) filter dropdown in the catalogue toolbar and select the '4' size option";

const CLICK_STEPS = [
  { step: REGION_STEP, payloadField: "regions" },
  { step: SIZE_STEP, payloadField: "unitCounts" },
];
const DECLARED_FACETS = ["payload.regions", "payload.unitCounts"];

const FILTERS = ["ALPS;filterType=region", "4;filterType=size"];
const FACET_REF = /payload\.\w+/g;

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
    requestPostData: JSON.stringify({ pageSize: 20, filters: FILTERS }),
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
  workDir = mkdtempSync(join(tmpdir(), "barnacle-click-facet-kind-mismatch-parity-"));
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

  const siteId = `click-facet-kind-mismatch-parity-test-${process.pid}`;
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

function arrayFacetRefs(contract: string): string[] {
  const elements = contract.match(/`[^`]*;filterType=\w+[^`]*`/g) ?? [];
  return [...new Set(elements.flatMap((element) => element.match(FACET_REF) ?? []))].sort();
}

describe("recon-generate CLI — kind-mismatched click facet transport parity", () => {
  it("threads the same declared facets into the kind-suffixed array on every emitter", () => {
    const multi = generate([restCapture(), graphqlCapture(), submitCapture()], {
      steps: [...CLICK_STEPS, { step: "submit the order", submitStep: true }],
      submitEndpointPattern: "submit",
      requireSubmitEndpointMatch: true,
    });
    const single = generate([restCapture(), graphqlCapture()], { steps: CLICK_STEPS });
    const gql = generate([graphqlCapture()], { steps: CLICK_STEPS });

    for (const contract of [multi, single, gql]) {
      expect(arrayFacetRefs(contract), contract).toEqual(DECLARED_FACETS);
      expect(contract).not.toContain("ALPS;filterType=region");
      expect(contract).not.toContain("4;filterType=size");
    }
    expect(arrayFacetRefs(single)).toEqual(arrayFacetRefs(multi));
    expect(arrayFacetRefs(gql)).toEqual(arrayFacetRefs(multi));
  }, 120_000);
});
