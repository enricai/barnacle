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
 * Combined end-to-end proof for both `recon-generate` fixes named in this
 * subtask, generating the real contract.ts via `emitContractTs` and then
 * running the report's own verification method (typecheck + lint the
 * output) plus a runtime execution of the emitted fold — rather than two
 * isolated unit assertions:
 *
 * (1) `mergeSpecPlanOntoSamePrimary`/`buildFoldPlanFromSpec` must honor a
 * flow's declared `foldReturn.joinFields` when the drill response repeats
 * BOTH primary items' own shape (a decoy row for each item positioned
 * ahead of its real match), so the fold matches by the declared
 * `productId` field instead of a structural/positional fallback — and
 * never leaks the decoy-only `promo` field onto a real row that never had
 * one (the "optional nested field absent from real fixture rows" case).
 *
 * (2) the chain-loop fix must only bind a drill chain hop's response to a
 * local when it is the chain terminal or a later hop's request actually
 * threads a value out of it — an inert middle hop (here, a hold/confirm
 * call whose own response is read by nothing) must be emitted as a bare
 * `await httpClient(...)`, never a dead `const rN = `, or the generated
 * contract.ts fails Biome's `noUnusedVariables`.
 */

const REPO_ROOT = resolve(__dirname, "..", "..");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const BIOME_BIN = join(REPO_ROOT, "node_modules", ".bin", "biome");

const BASE_URL = "https://api.example.com";
const SEARCH_URL = `${BASE_URL}/catalog/search`;
const AVAILABILITY_URL = `${BASE_URL}/catalog/availability`;
const HOLD_URL = `${BASE_URL}/catalog/hold`;
const DETAILS_URL = `${BASE_URL}/catalog/details`;

// >= indexStateValues' MIN_STATE_VALUE_LENGTH (8) floor.
const SESSION_TOKEN = "sess-token-abcdefgh";

/**
 * A 2-hop bootstrap chain (`availability` mints a session token; `hold`
 * threads it onward but its own `{ held: true }` response is read by
 * nothing) followed by the declared drill terminal (`details`), whose
 * response repeats BOTH primary items — a decoy row for each ahead of its
 * real match, and `promo` present ONLY on the decoy rows (an optional
 * nested field genuinely absent from every real row).
 */
function fixtureCaptures(): Capture[] {
  const search = buildCapture({
    url: SEARCH_URL,
    requestPostData: '{"page":1}',
    responseBody: { results: [{ productId: "widget-01" }, { productId: "widget-02" }] },
    timestamp: "2026-01-01T00:00:00Z",
  });
  const availability = buildCapture({
    url: AVAILABILITY_URL,
    requestPostData: '{"scope":"catalog"}',
    responseBody: { sessionToken: SESSION_TOKEN },
    timestamp: "2026-01-01T00:00:01Z",
  });
  // Dead middle hop: threads sessionToken onward but its own response
  // (`{ held: true }`) is read by nothing downstream — the exact shape
  // that used to force a dead `const rN = ` binding.
  const hold = buildCapture({
    url: HOLD_URL,
    requestPostData: JSON.stringify({ sessionToken: SESSION_TOKEN }),
    responseBody: { held: true },
    timestamp: "2026-01-01T00:00:02Z",
  });
  // Declared drill terminal: a decoy row — repeating the primary array's own
  // shape but matching NEITHER real item's `productId` — positioned ahead of
  // each item's own real match, proving the fold matches by the declared
  // `productId` field rather than array position. `promo` appears only on
  // the decoy rows, never the real ones.
  const details = buildCapture({
    url: DETAILS_URL,
    requestPostData: JSON.stringify({ sessionToken: SESSION_TOKEN }),
    responseBody: {
      rows: [
        { productId: "decoy-01", inStock: false, promo: { code: "DECOY-01" } },
        { productId: "widget-01", inStock: true },
        { productId: "decoy-02", inStock: false, promo: { code: "DECOY-02" } },
        { productId: "widget-02", inStock: true },
      ],
    },
    timestamp: "2026-01-01T00:00:03Z",
  });
  return [search, availability, hold, details];
}

const SPEC: FoldReturnSpec = {
  endpointPattern: "/catalog/details",
  resultsPath: "results",
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
    "FoldreturnJoinfieldsTwoHopChainTest"
  );

  return emitContractTs({
    siteId,
    pascal: "FoldreturnJoinfieldsTwoHopChainTest",
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

describe("recon-generate foldReturn declared joinFields + 2-hop drill chain — combined runtime e2e", () => {
  it("emits a contract.ts that typechecks, lints clean, and merges by the declared join field at runtime", async () => {
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }
    if (!existsSync(BIOME_BIN)) {
      throw new Error("biome binary not found — run pnpm install");
    }

    const siteId = `foldreturn-joinfields-two-hop-chain-typecheck${process.pid}`;
    const contract = generateContract(siteId);

    // The dead hold-hop response must never be bound to a local — only the
    // availability (produces sessionToken) and details (chain terminal)
    // responses are.
    expect(contract).toMatch(/await httpClient\(`\$\{payload\.BaseUrl\}\/catalog\/hold`/);
    expect(contract).not.toMatch(
      /const \w+ = \(await httpClient\(`\$\{payload\.BaseUrl\}\/catalog\/hold`/
    );
    expect(contract).toMatch(
      /const \w+ = \(await httpClient\(`\$\{payload\.BaseUrl\}\/catalog\/details`/
    );

    const executeHttpBody = extractExecuteHttpBodyFromContract(contract);

    // (1) typecheck: the generated contract.ts must compile with zero
    // diagnostics against its own discovered schema, including the optional
    // nested `promo` field that's genuinely absent from every real row.
    // Written under src/sites/ (like the CLI itself would) since tsc's
    // configured rootDir rejects files outside the repo tree.
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(join(siteOutDir, "flows"), { recursive: true });
    const contractFile = join(siteOutDir, "contract.ts");
    writeFileSync(contractFile, contract);
    // contract.ts imports the browser-flow module by relative path — write a
    // real one (via the same emitter the CLI uses) so tsc can resolve it.
    const { code: browserFlowCode } = emitBrowserFlowTs({
      siteId,
      pascal: "FoldreturnJoinfieldsTwoHopChainTest",
      baseUrl: BASE_URL,
      flowSteps: [
        { step: "search the catalog" },
        { step: "check availability" },
        { step: "place a hold" },
        { step: "open item details" },
      ],
      isSubmissionFlow: true,
    });
    writeFileSync(join(siteOutDir, "flows", "browser-flow.ts"), browserFlowCode);

    tsconfigPath = join(REPO_ROOT, `tsconfig.foldreturn-joinfields-two-hop-chain.${process.pid}.json`);
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

    // (2) lint: the emitted executeHttp body must never leave the dead
    // hold-hop response (or anything else) bound but unread.
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
    // each item with ITS OWN real row, never the decoy ahead of it in the
    // drill response, and the optional `promo` field never leaks onto a
    // real row that never had one.
    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
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

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/catalog/search")) {
        return jsonResponse({
          results: [{ productId: "widget-01" }, { productId: "widget-02" }],
        });
      }
      if (url.includes("/catalog/availability")) {
        return jsonResponse({ sessionToken: SESSION_TOKEN });
      }
      if (url.includes("/catalog/hold")) {
        return jsonResponse({ held: true });
      }
      if (url.includes("/catalog/details")) {
        return jsonResponse({
          rows: [
            { productId: "decoy-01", inStock: false, promo: { code: "DECOY-01" } },
            { productId: "widget-01", inStock: true },
            { productId: "decoy-02", inStock: false, promo: { code: "DECOY-02" } },
            { productId: "widget-02", inStock: true },
          ],
        });
      }
      throw new Error(`unstubbed fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const executeHttp = evalExecuteHttpBody(executeHttpBody, httpClient, z);
    const result = await executeHttp({ BaseUrl: BASE_URL, page: 1, scope: "catalog" });

    const data = result.data as { results: Array<Record<string, unknown>> };
    const byProductId = new Map(data.results.map((row) => [row.productId as string, row]));

    expect(byProductId.get("widget-01")).toEqual({ productId: "widget-01", inStock: true });
    expect(byProductId.get("widget-02")).toEqual({ productId: "widget-02", inStock: true });
    // Neither real merged row ever picked up a decoy's `inStock: false`/
    // `promo` — proof the join actually matched by the declared `productId`
    // field, skipping the structurally-identical decoy that sits ahead of
    // it in the drill response, not the first candidate found.
    expect(data.results.every((row) => !("promo" in row))).toBe(true);

    // The dead hold hop still fires exactly once (chain replay is
    // faithful) even though its response is never bound to a local.
    const holdCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/catalog/hold"));
    expect(holdCalls).toHaveLength(1);
  });
});
