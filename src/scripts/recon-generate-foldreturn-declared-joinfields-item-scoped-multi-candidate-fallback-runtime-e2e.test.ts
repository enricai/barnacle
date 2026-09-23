import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Bottleneck from "bottleneck";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import {
  compileActionSteps,
  emitBrowserFlowTs,
  emitContractTs,
  emitMultiStepExecuteHttp,
  type FoldReturnSpec,
  indexStateValues,
} from "@/scripts/recon-generate";
import {
  evalExecuteHttpBody,
  extractExecuteHttpBodyFromContract,
} from "@/scripts/recon-generate-execute-http-harness.test-helper";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Combined end-to-end proof (mirroring
 * recon-generate-foldreturn-declared-joinfields-two-hop-chain-runtime-e2e.test.ts's
 * generate + typecheck + lint + execute style) that an item-scoped PER-ITEM
 * drill loop — one `httpClient` POST issued per primary item, not a single
 * shared drill call — honors a flow's declared `foldReturn.joinFields` when
 * EACH item's own drill response repeats two candidate rows sharing an
 * identical nested `priceSummary` sub-object (a decoy listed first,
 * disambiguated from the real match ONLY by the declared `productId`
 * field, never by the request body, which is unthreaded past the item's own
 * id). Proves the drill response is never left unused (guards Finding 1
 * against regressing while Finding 2 is fixed) and that each item's fold
 * result actually comes from ITS OWN matching candidate row at runtime, not
 * the first/decoy row every item would get under an unfixed structural
 * currency/taxIncluded fallback.
 */

const REPO_ROOT = resolve(__dirname, "..", "..");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const BIOME_BIN = join(REPO_ROOT, "node_modules", ".bin", "biome");

const BASE_URL = "https://api.example.com";
const SEARCH_URL = `${BASE_URL}/catalog/search`;
const DETAILS_URL = `${BASE_URL}/catalog/details`;

/**
 * Two primary catalog items, each with its own per-item drill-down request
 * (`{"productId": ...}`) whose response repeats two candidate rows sharing
 * an identical nested `priceSummary` object — a decoy row (positioned
 * first, non-matching `productId`) and the real match — so the fold must
 * disambiguate by the declared `productId` join field rather than any
 * structural difference in the candidates' shape.
 */
function fixtureCaptures(): Capture[] {
  const search = buildCapture({
    url: SEARCH_URL,
    requestPostData: '{"page":1}',
    responseBody: { results: [{ productId: "widget-01" }, { productId: "widget-02" }] },
    timestamp: "2026-01-01T00:00:00Z",
  });
  // A single example per-item drill call (for widget-01) — the generator
  // infers the per-item loop from this one capture, then re-issues its own
  // POST per primary item at runtime.
  const details = buildCapture({
    url: DETAILS_URL,
    requestPostData: '{"productId":"widget-01"}',
    responseBody: {
      candidates: [
        {
          productId: "decoy-01",
          inStock: false,
          priceSummary: { currency: "USD", taxIncluded: true },
        },
        {
          productId: "widget-01",
          inStock: true,
          priceSummary: { currency: "USD", taxIncluded: true },
        },
      ],
    },
    timestamp: "2026-01-01T00:00:01Z",
  });
  return [search, details];
}

const SPEC: FoldReturnSpec = {
  endpointPattern: "/catalog/details",
  resultsPath: "results",
  drillResultsPath: "candidates",
  joinFields: ["productId"],
};

function generateContract(siteId: string): string {
  const captures = fixtureCaptures();
  const actionCaptures = captures.map((capture, index) => ({ capture, index }));
  const stateIndex = indexStateValues(captures);
  const actionSteps = compileActionSteps(actionCaptures, stateIndex);
  const inputBody = JSON.parse(captures[0]!.requestPostData ?? "null") as unknown;

  const multiStepBody = emitMultiStepExecuteHttp(
    actionSteps,
    inputBody,
    { stringMessageKey: null, nestedErrorPaths: [] },
    new Map(),
    new Set(),
    new Map(),
    new Set(),
    new Map(),
    new Map(),
    BASE_URL,
    new Map(),
    new Map(),
    null,
    new Map(),
    new Map(),
    new Set(),
    [],
    new Map(),
    new Map(),
    SPEC,
    "FoldreturnJoinfieldsItemScopedMultiCandidateTest"
  );

  return emitContractTs({
    siteId,
    pascal: "FoldreturnJoinfieldsItemScopedMultiCandidateTest",
    baseUrl: BASE_URL,
    baseHeaders: { "Content-Type": "application/json" },
    minTime: 100,
    safeRps: 10,
    responseBody: captures[0]!.responseBody,
    gql: false,
    gqlQuery: null,
    endpointPath: "/catalog/search",
    gqlOperationName: null,
    gqlVariables: null,
    auxFiles: [],
    actionSteps,
    foldReturnSpec: SPEC,
    multiStepBody,
    isSubmissionFlow: true,
    inputBody,
  });
}

let tsconfigPath: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (tsconfigPath) rmSync(tsconfigPath, { force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  tsconfigPath = null;
  siteOutDir = null;
});

describe("recon-generate foldReturn declared joinFields — item-scoped per-item drill loop, multi-candidate fallback — combined runtime e2e", () => {
  it("emits a contract.ts that typechecks, lints clean, and merges each item with its own matching candidate at runtime", async () => {
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }
    if (!existsSync(BIOME_BIN)) {
      throw new Error("biome binary not found — run pnpm install");
    }

    const siteId = `foldreturn-joinfields-item-scoped-multi-candidate-typecheck${process.pid}`;
    const contract = generateContract(siteId);

    // The per-item drill response must always be bound and read — never a
    // dead `await httpClient(...)` whose result is discarded (Finding 1
    // regression guard).
    expect(contract).toMatch(
      /const \w+ = \(await httpClient\(`\$\{payload\.BaseUrl\}\/catalog\/details`/
    );

    const executeHttpBody = extractExecuteHttpBodyFromContract(contract);

    // (1) typecheck: the generated contract.ts must compile with zero
    // diagnostics against its own discovered schema. Written under
    // src/sites/ (like the CLI itself would) since tsc's configured rootDir
    // rejects files outside the repo tree.
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(join(siteOutDir, "flows"), { recursive: true });
    const contractFile = join(siteOutDir, "contract.ts");
    writeFileSync(contractFile, contract);
    // contract.ts imports the browser-flow module by relative path — write a
    // real one (via the same emitter the CLI uses) so tsc can resolve it.
    const { code: browserFlowCode } = emitBrowserFlowTs({
      siteId,
      pascal: "FoldreturnJoinfieldsItemScopedMultiCandidateTest",
      baseUrl: BASE_URL,
      flowSteps: [{ step: "search the catalog" }, { step: "open item details" }],
      isSubmissionFlow: true,
    });
    writeFileSync(join(siteOutDir, "flows", "browser-flow.ts"), browserFlowCode);

    tsconfigPath = join(
      REPO_ROOT,
      `tsconfig.foldreturn-joinfields-item-scoped-multi-candidate.${process.pid}.json`
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
    const typecheck = execFileSync(TSC_BIN, ["-p", tsconfigPath, "--noEmit"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: "pipe",
    });
    expect(typecheck).not.toContain("contract.ts");

    // (2) lint: the emitted executeHttp body must never leave the per-item
    // drill response bound but unread (Finding 1 regression guard).
    const lintDir = mkdtempSync(join(tmpdir(), "barnacle-biome-"));
    try {
      writeFileSync(
        join(lintDir, "biome.json"),
        JSON.stringify({
          $schema: "https://biomejs.dev/schemas/2.3.11/schema.json",
          formatter: { enabled: false },
          assist: { enabled: false },
          linter: {
            enabled: true,
            rules: { recommended: false, correctness: { noUnusedVariables: "error" } },
          },
        })
      );
      const lintFile = join(lintDir, "executeHttp.ts");
      writeFileSync(
        lintFile,
        [
          "async function executeHttp(",
          "  httpClient: (url: string, init: unknown) => Promise<unknown>,",
          "  payload: Record<string, unknown>,",
          "): Promise<{ data: unknown }> {",
          executeHttpBody,
          "}",
          "void executeHttp;",
        ].join("\n")
      );
      expect(() =>
        execFileSync(BIOME_BIN, ["lint", "--config-path", lintDir, lintFile], {
          cwd: lintDir,
          encoding: "utf8",
          stdio: "pipe",
        })
      ).not.toThrow();
    } finally {
      rmSync(lintDir, { recursive: true, force: true });
    }

    // (3) runtime: executing the generated fold-merge logic actually merges
    // each item with ITS OWN real candidate row, never the decoy sharing
    // its identical nested `priceSummary`, and never the OTHER item's
    // candidate.
    const limiter = new Bottleneck({ maxConcurrent: 2, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    const jsonResponse = (
      body: unknown
    ): { status: number; ok: boolean; text: () => Promise<string>; headers: Headers } => ({
      status: 200,
      ok: true,
      text: vi.fn().mockResolvedValue(JSON.stringify(body)),
      headers: new Headers(),
    });

    const CANDIDATES_BY_PRODUCT_ID: Record<
      string,
      { candidates: { productId: string; inStock: boolean; priceSummary: unknown }[] }
    > = {
      "widget-01": {
        candidates: [
          {
            productId: "decoy-01",
            inStock: false,
            priceSummary: { currency: "USD", taxIncluded: true },
          },
          {
            productId: "widget-01",
            inStock: true,
            priceSummary: { currency: "USD", taxIncluded: true },
          },
        ],
      },
      "widget-02": {
        candidates: [
          {
            productId: "decoy-02",
            inStock: false,
            priceSummary: { currency: "USD", taxIncluded: true },
          },
          {
            productId: "widget-02",
            inStock: true,
            priceSummary: { currency: "USD", taxIncluded: true },
          },
        ],
      },
    };

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/catalog/search")) {
        return jsonResponse({
          results: [{ productId: "widget-01" }, { productId: "widget-02" }],
        });
      }
      if (url.includes("/catalog/details")) {
        const { productId } = JSON.parse(String(init?.body)) as { productId: string };
        const response = CANDIDATES_BY_PRODUCT_ID[productId];
        if (!response) {
          throw new Error(`unstubbed drill call for productId "${productId}"`);
        }
        return jsonResponse(response);
      }
      throw new Error(`unstubbed fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const executeHttp = evalExecuteHttpBody(executeHttpBody, httpClient, z);
    const result = await executeHttp({ BaseUrl: BASE_URL, page: 1 });

    const data = result.data as { results: Array<Record<string, unknown>> };
    const byProductId = new Map(data.results.map((row) => [row.productId as string, row]));

    // Each item ends up merged with ITS OWN real candidate — never the
    // decoy (which would carry `inStock: false`) and never the other
    // item's candidate.
    const expectedPriceSummary = { currency: "USD", taxIncluded: true };
    expect(byProductId.get("widget-01")).toEqual({
      productId: "widget-01",
      inStock: true,
      priceSummary: expectedPriceSummary,
    });
    expect(byProductId.get("widget-02")).toEqual({
      productId: "widget-02",
      inStock: true,
      priceSummary: expectedPriceSummary,
    });
    expect(data.results.every((row) => row.inStock === true)).toBe(true);

    // Every per-item drill call must have been correctly parameterized —
    // one POST per primary item, each carrying that item's own productId.
    const detailsCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/catalog/details")
    );
    const detailsBodies = detailsCalls.map(
      ([, init]) => (JSON.parse(String(init?.body)) as { productId: string }).productId
    );
    expect(detailsBodies.sort()).toEqual(["widget-01", "widget-02"]);
  });
});
