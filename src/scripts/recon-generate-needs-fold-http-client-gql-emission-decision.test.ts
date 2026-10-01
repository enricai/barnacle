import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  compileActionSteps,
  emitContractTs,
  extractGraphQLActionSequence,
  type FoldReturnSpec,
  indexStateValues,
} from "@/scripts/recon-generate";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins the one confirmed `isGqlEmission` violation this subtask fixes:
 * `needsFoldHttpClient` (recon-generate.ts, just below `singlePrimaryFoldPlans`)
 * used to read the raw `gql` flag instead of `isGqlEmission`. A structurally-
 * detected fold plan (resolved from `actionSteps`/`foldReturnSpec` alone, with
 * no dependency on `gqlQuery`) under `gql: true` / `gqlQuery: null` therefore
 * still took the `createHttpClient` branch — correct by coincidence, since
 * that branch happens to be what REST emission also wants — but for the wrong
 * reason, keyed off a flag `isGqlEmission`'s own doc comment names as unsafe
 * to read directly. This test drives that exact shape directly (gql=true,
 * gqlQuery=null, a real foldPlan from actionSteps) and asserts both no
 * undeclared `_QUERY` reference AND that the emitted contract.ts actually
 * typechecks — the gate the raw-`gql` read could silently violate if a
 * future change made it diverge from `isGqlEmission` elsewhere in the branch.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const BASE = "https://api.example.com";

function catalogSearchCapture(): Capture {
  return {
    timestamp: "2026-01-01T00:00:00Z",
    phase: "browse",
    method: "POST",
    url: `${BASE}/graphql`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ variables: {} }),
    responseHeaders: {},
    responseBody: {
      catalogSearch: {
        postings: [{ id: "post-1", catalogNumber: "CAT-1", title: "Book A" }],
      },
    },
    operationName: "catalogSearch",
    query: null,
    variables: {},
    decodedParams: null,
  };
}

function editionsDrillCapture(): Capture {
  return {
    timestamp: "2026-01-01T00:00:01Z",
    phase: "browse",
    method: "GET",
    url: `${BASE}/library/api/v1/editions/1`,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: { edition: [{ catalogNumber: "CAT-1", location: "Shelf-1" }] },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

const SPEC: FoldReturnSpec = {
  endpointPattern: "/library/api/v1/editions/",
  resultsPath: "catalogSearch.postings",
  drillResultsPath: "edition",
  joinFields: ["catalogNumber"],
};

let siteOutDir: string | null = null;
let tsconfigPath: string | null = null;

afterEach(() => {
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  if (tsconfigPath) rmSync(tsconfigPath, { force: true });
  siteOutDir = null;
  tsconfigPath = null;
});

describe("emitContractTs — needsFoldHttpClient under gql=true/gqlQuery=null with a resolved fold plan", () => {
  it("emits createHttpClient (not createGraphqlClient), no undeclared _QUERY reference, and typechecks clean", () => {
    const captures = [catalogSearchCapture(), editionsDrillCapture()];
    const actionCaptures = extractGraphQLActionSequence(captures, null, SPEC);
    const stateIndex = indexStateValues(
      captures,
      new Set(),
      new Set(actionCaptures.map((a) => a.index))
    );
    const actionSteps = compileActionSteps(actionCaptures, stateIndex);
    expect(actionSteps.length).toBeGreaterThan(0);

    const siteId = `needs-fold-http-client-gql-emission-test${process.pid}`;
    const source = emitContractTs({
      siteId,
      pascal: "NeedsFoldHttpClientGqlEmissionFixture",
      baseUrl: BASE,
      baseHeaders: { "Content-Type": "application/json" },
      minTime: 100,
      safeRps: 10,
      responseBody: actionSteps[0]!.capture.responseBody,
      gql: true,
      gqlQuery: null,
      endpointPath: "/graphql",
      gqlOperationName: "catalogSearch",
      gqlVariables: {},
      auxFiles: [],
      actionSteps,
      foldReturnSpec: SPEC,
    });

    const references = [...source.matchAll(/\b([A-Z][A-Z0-9_]*_QUERY)\b/g)].map((m) => m[1]!);
    const declarations = [...source.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*_QUERY)\s*=/g)].map(
      (m) => m[1]!
    );
    const undeclaredReferences = references.filter((name) => !declarations.includes(name));
    expect(undeclaredReferences, source).toEqual([]);
    expect(source).not.toContain("createGraphqlClient");
    expect(source).toContain("createHttpClient");

    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(join(siteOutDir, "flows"), { recursive: true });
    writeFileSync(join(siteOutDir, "contract.ts"), source);
    writeFileSync(
      join(siteOutDir, "flows", "browser-flow.ts"),
      `export async function runNeedsFoldHttpClientGqlEmissionFixtureBrowserFlow(
  stagehand: unknown,
  baseUrl: unknown,
  payload: unknown,
  sessionProxy: unknown
): Promise<unknown> {
  return undefined;
}
`
    );

    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted source compiles");
    }
    tsconfigPath = join(
      REPO_ROOT,
      `tsconfig.needs-fold-http-client-gql-emission.${process.pid}.json`
    );
    writeFileSync(
      tsconfigPath,
      JSON.stringify({
        extends: "./tsconfig.json",
        compilerOptions: {
          noEmit: true,
          incremental: false,
          tsBuildInfoFile: null,
          paths: {
            "@/*": ["./src/*"],
            "@test/*": ["./test/*"],
            "@enricai/barnacle/*": ["./src/*"],
          },
        },
        include: [`${siteOutDir.slice(REPO_ROOT.length + 1)}/**/*.ts`],
      })
    );
    const check = spawnSync(TSC_BIN, ["-p", tsconfigPath, "--noEmit"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    const diagnostics = `${check.stdout}\n${check.stderr}`;
    expect(check.status, diagnostics).toBe(0);
  }, 60_000);
});
