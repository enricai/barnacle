import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import {
  compileActionSteps,
  emitContractTs,
  extractGraphQLActionSequence,
  type FoldReturnSpec,
  indexStateValues,
  resolveApplicableFoldPlans,
} from "@/scripts/recon-generate";
import { extractExecuteHttpBodyFromContract } from "@/scripts/recon-generate-execute-http-harness.test-helper";

const BASE = "https://api.example.com";
const REPO_ROOT = join(__dirname, "..", "..");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");

/**
 * Locks in the bugfix-001 fix: a fold plan whose `primaryArrayPath` is
 * STRICTLY DEEPER than the paginated collection's own array path (e.g. a
 * per-item nested array, declared via a `*` wildcard segment in the flow's
 * `resultsPath`) must still fold onto that deeper element, not the flat
 * paginated item — and `itemsById` must be typed to the real generated item
 * type, not `unknown`.
 */
const SEARCH_QUERY =
  "query catalogSearch($skip: Int, $take: Int) { catalogSearch(skip: $skip, take: $take) { total items { id title groups { code name } } } }";

function catalogSearchCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:00Z",
    phase: "browse",
    method: "POST",
    url: `${BASE}/graphql`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ query: SEARCH_QUERY, variables: { skip: 0, take: 2 } }),
    responseHeaders: {},
    responseBody: {
      catalogSearch: {
        total: 4,
        items: [
          { id: "entry-1", title: "Entry One", groups: [{ code: "n", name: "North" }] },
          { id: "entry-2", title: "Entry Two", groups: [{ code: "s", name: "South" }] },
        ],
      },
    },
    operationName: "catalogSearch",
    query: SEARCH_QUERY,
    variables: { skip: 0, take: 2 },
    decodedParams: null,
  };
}

function restDrillDownCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:01Z",
    phase: "browse",
    method: "GET",
    url: `${BASE}/catalog/api/v1/details?code=n`,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: { detail: [{ code: "n", climate: "temperate" }] },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

const NESTED_GROUP_SPEC: FoldReturnSpec = {
  endpointPattern: "/catalog/api/v1/details",
  resultsPath: "catalogSearch.items.*.groups",
  drillResultsPath: "detail",
  joinFields: ["code"],
};

function buildActionSteps(): {
  actionSteps: ReturnType<typeof compileActionSteps>;
  primaryResponseBody: unknown;
} {
  const captures = [catalogSearchCapture(), restDrillDownCapture()] as never[];
  const actionCaptures = extractGraphQLActionSequence(captures, null, NESTED_GROUP_SPEC);
  const stateIndex = indexStateValues(
    captures,
    new Set(),
    new Set(actionCaptures.map((a) => a.index))
  );
  const actionSteps = compileActionSteps(actionCaptures, stateIndex);
  return { actionSteps, primaryResponseBody: actionSteps[0]?.capture.responseBody };
}

describe("paginated GraphQL fold onto a primaryArrayPath deeper than the pagination array path", () => {
  it("resolves a fold plan whose primaryArrayPath strictly extends the pagination signal's own array path", () => {
    const { actionSteps } = buildActionSteps();
    const foldPlans = resolveApplicableFoldPlans(actionSteps, NESTED_GROUP_SPEC, undefined);

    expect(foldPlans.length).toBeGreaterThan(0);
    expect(foldPlans[0]!.primaryArrayPath).toEqual(["catalogSearch", "items", "*", "groups"]);
  });

  it("emits a single-flatMap descent into the nested array, types itemsById to the real item type, and joins on the nested element", () => {
    const { actionSteps, primaryResponseBody } = buildActionSteps();
    const contract = emitContractTs({
      siteId: "paginated-nested-fold-test",
      pascal: "PaginatedNestedFoldTest",
      baseUrl: BASE,
      baseHeaders: { "Content-Type": "application/json" },
      minTime: 100,
      safeRps: 10,
      responseBody: primaryResponseBody,
      gql: true,
      gqlQuery: SEARCH_QUERY,
      endpointPath: "/graphql",
      gqlOperationName: "catalogSearch",
      gqlVariables: { skip: 0, take: 2 },
      auxFiles: [],
      actionSteps,
      foldReturnSpec: NESTED_GROUP_SPEC,
    });

    // itemsById is typed off the real generated response type at the
    // pagination signal's own array path — never `unknown`.
    expect(contract).toContain(
      'const itemsById = new Map<string, PaginatedNestedFoldTestResponse["catalogSearch"]["items"][number]>();'
    );
    expect(contract).not.toContain("new Map<string, unknown>()");

    const body = extractExecuteHttpBodyFromContract(contract);

    // `itemsById.values()` already stands in for the pagination array's own
    // iteration, so descending the residual `*.groups` suffix is a nested
    // `for` over each paginated item's groups (not a second flatMap) — see
    // pathToFoldLoopLines's docstring.
    const foldLoopLine = /for \(const g0 of \(([\s\S]*?)\)\) \{/.exec(body);
    expect(foldLoopLine).not.toBeNull();
    const foldLoopExpr = foldLoopLine![1]!;
    expect(foldLoopExpr).toContain("itemsById.values()");
    expect(body).toContain("for (const item of g0.groups) {");

    // The join/threaded URL param and the merge both read off the nested
    // group item's own `code` field, not the outer paginated item's.
    expect(body).toContain("item.code");
    expect(body).toContain(
      "Object.assign(item, Object.fromEntries(Object.entries(foldMatch ?? {}).filter(([k]) => !(k in item))));"
    );
  });

  it("compiles with zero tsc diagnostics end to end through the real CLI", () => {
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }

    const siteId = `paginated-nested-fold-tsc-test${process.pid}`;
    const pascal = `PaginatedNestedFoldTscTest${process.pid}`;
    const { actionSteps, primaryResponseBody } = buildActionSteps();
    const contract = emitContractTs({
      siteId,
      pascal,
      baseUrl: BASE,
      baseHeaders: { "Content-Type": "application/json" },
      minTime: 100,
      safeRps: 10,
      responseBody: primaryResponseBody,
      gql: true,
      gqlQuery: SEARCH_QUERY,
      endpointPath: "/graphql",
      gqlOperationName: "catalogSearch",
      gqlVariables: { skip: 0, take: 2 },
      auxFiles: [],
      actionSteps,
      foldReturnSpec: NESTED_GROUP_SPEC,
    });

    const siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    const tsconfigPath = join(REPO_ROOT, `tsconfig.paginated-nested-fold-tsc.${process.pid}.json`);
    try {
      mkdirSync(join(siteOutDir, "flows"), { recursive: true });
      writeFileSync(join(siteOutDir, "contract.ts"), contract);
      writeFileSync(
        join(siteOutDir, "flows", "browser-flow.ts"),
        `import type { Stagehand } from "@browserbasehq/stagehand";
export async function run${pascal}BrowserFlow(
  _stagehand: Stagehand,
  _baseUrl: string,
  _payload: unknown
): Promise<unknown> {
  return {};
}
`
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
          include: [`src/sites/${siteId}/**/*.ts`],
        })
      );

      const check = spawnSync(TSC_BIN, ["-p", tsconfigPath, "--noEmit"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      });

      const diagnostics = `${check.stdout}\n${check.stderr}`;
      expect(check.status, diagnostics).toBe(0);
    } finally {
      rmSync(siteOutDir, { recursive: true, force: true });
      rmSync(tsconfigPath, { force: true });
    }
  }, 60_000);
});
