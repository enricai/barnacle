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
 * Runtime e2e proof that a single-hop drill (one bare `httpClient` call, no
 * intermediate chain hop) still honors a flow's declared `foldReturn.joinFields`
 * when every drill row carries an IDENTICAL nested sub-object across every row
 * (`priceSummary: { currency, taxIncluded }`), so a nested-field structural
 * guess cannot even distinguish rows — the fold must key off the declared
 * `reservationId` instead, not fall back to (or collapse ambiguously around)
 * the identical nested shape.
 */

const REPO_ROOT = resolve(__dirname, "..", "..");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const BIOME_BIN = join(REPO_ROOT, "node_modules", ".bin", "biome");

const BASE_URL = "https://api.example.com";
const SEARCH_URL = `${BASE_URL}/catalog/reservations`;
const DETAILS_URL = `${BASE_URL}/catalog/reservation-details`;

/**
 * A single-hop drill: `search` returns the primary reservations, `details`
 * (the declared drill terminal) is the ONLY other call — no bootstrap or
 * chain hop sits between them. Every details row shares the exact same
 * `priceSummary` sub-object, so a structural join on that nested shape can
 * never tell rows apart; only the declared `reservationId` field can.
 */
function fixtureCaptures(): Capture[] {
  const search = buildCapture({
    url: SEARCH_URL,
    requestPostData: '{"scope":"catalog"}',
    responseBody: {
      results: [{ reservationId: "res-01" }, { reservationId: "res-02" }],
    },
    timestamp: "2026-01-01T00:00:00Z",
  });
  const details = buildCapture({
    url: DETAILS_URL,
    requestPostData: '{"scope":"catalog"}',
    responseBody: {
      rows: [
        {
          reservationId: "res-01",
          confirmed: true,
          priceSummary: { currency: "USD", taxIncluded: true },
        },
        {
          reservationId: "res-02",
          confirmed: false,
          priceSummary: { currency: "USD", taxIncluded: true },
        },
      ],
    },
    timestamp: "2026-01-01T00:00:01Z",
  });
  return [search, details];
}

const SPEC: FoldReturnSpec = {
  endpointPattern: "/catalog/reservation-details",
  resultsPath: "results",
  joinFields: ["reservationId"],
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
    "FoldreturnJoinfieldsSingleHopNestedFallbackTest"
  );

  return emitContractTs({
    siteId,
    pascal: "FoldreturnJoinfieldsSingleHopNestedFallbackTest",
    baseUrl: BASE_URL,
    baseHeaders: { "Content-Type": "application/json" },
    minTime: 100,
    safeRps: 10,
    responseBody: captures[0]!.responseBody,
    gql: false,
    gqlQuery: null,
    endpointPath: "/catalog/reservations",
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

describe("recon-generate foldReturn declared joinFields — single-hop, identical nested price-summary rows — runtime e2e", () => {
  it("emits a contract.ts that typechecks, lints clean, and merges by the declared join field, never the identical nested shape", async () => {
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }
    if (!existsSync(BIOME_BIN)) {
      throw new Error("biome binary not found — run pnpm install");
    }

    const siteId = `foldreturn-joinfields-single-hop-nested-fallback${process.pid}`;
    const contract = generateContract(siteId);

    // A single-hop drill: exactly one bare/bound httpClient call against the
    // details endpoint, no intermediate chain hop in between.
    expect(contract).toMatch(
      /await httpClient\(`\$\{payload\.BaseUrl\}\/catalog\/reservation-details`/
    );

    const executeHttpBody = extractExecuteHttpBodyFromContract(contract);

    // (1) typecheck: the generated contract.ts must compile with zero
    // diagnostics against its own discovered schema, including the shared
    // nested `priceSummary` shape repeated identically across every row.
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
      pascal: "FoldreturnJoinfieldsSingleHopNestedFallbackTest",
      baseUrl: BASE_URL,
      flowSteps: [{ step: "search reservations" }, { step: "open reservation details" }],
      isSubmissionFlow: true,
    });
    writeFileSync(join(siteOutDir, "flows", "browser-flow.ts"), browserFlowCode);

    tsconfigPath = join(
      REPO_ROOT,
      `tsconfig.foldreturn-joinfields-single-hop-nested-fallback.${process.pid}.json`
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

    // (2) lint: the emitted executeHttp body must never leave anything
    // bound but unread.
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
    // each item with the drill row matching its OWN declared `reservationId`,
    // never a row that merely shares the identical nested `priceSummary`
    // shape (which is present, and equal, on every row).
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
      if (url.includes("/catalog/reservation-details")) {
        return jsonResponse({
          rows: [
            {
              reservationId: "res-01",
              confirmed: true,
              priceSummary: { currency: "USD", taxIncluded: true },
            },
            {
              reservationId: "res-02",
              confirmed: false,
              priceSummary: { currency: "USD", taxIncluded: true },
            },
          ],
        });
      }
      if (url.includes("/catalog/reservations")) {
        return jsonResponse({
          results: [{ reservationId: "res-01" }, { reservationId: "res-02" }],
        });
      }
      throw new Error(`unstubbed fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const executeHttp = evalExecuteHttpBody(executeHttpBody, httpClient, z);
    const result = await executeHttp({ BaseUrl: BASE_URL, scope: "catalog" });

    const data = result.data as { results: Array<Record<string, unknown>> };
    const byReservationId = new Map(data.results.map((row) => [row.reservationId as string, row]));

    // Each real item merges with ITS OWN row's `confirmed` flag — never the
    // other row's, which would happen if the fold matched off the identical
    // nested `priceSummary` shape instead of the declared `reservationId`.
    expect(byReservationId.get("res-01")).toEqual({
      reservationId: "res-01",
      confirmed: true,
      priceSummary: { currency: "USD", taxIncluded: true },
    });
    expect(byReservationId.get("res-02")).toEqual({
      reservationId: "res-02",
      confirmed: false,
      priceSummary: { currency: "USD", taxIncluded: true },
    });

    // A single-hop drill: the details endpoint is called exactly once per
    // primary item (no repeated intermediate chain hop).
    const detailsCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/catalog/reservation-details")
    );
    expect(detailsCalls).toHaveLength(2);
  });
});
