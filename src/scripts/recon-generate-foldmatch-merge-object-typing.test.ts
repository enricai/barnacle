import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { emitMultiStepExecuteHttp } from "@/scripts/recon-generate";
import {
  buildMulticallHeterogeneousActionStepsWithBookingSubmit,
  buildMulticallSingleShotSearchDrillDownNestedJoinFieldActionSteps,
} from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Regression for the report's secondary TS7053/TS18046/TS2740-class defects:
 * `emitFoldMatchAndMergeLines`'s `Object.assign(itemVar,
 * Object.fromEntries(Object.entries(foldMatch ?? {}).filter(...)))` merge
 * object, together with a fold chain's final response getting cast back to
 * the plugin's own inferred response schema, must both compile clean on a
 * regenerated `contract.ts` — not merely on a hand-picked fixture.
 *
 * Also pins the report's remaining `TS7053`/`TS18046`/`TS2740` trio on the
 * GraphQL `foldReturn` hot path (`emitContractTs`'s "getGql/httpClient
 * fold-merge" — `dataFoldMergeBlock; return { data };`,
 * recon-generate.ts:~11030 — which, unlike {@link emitMultiStepExecuteHttp}'s
 * `castToResponseType`-wrapped `return { data }`, emits `data` with NO
 * subsequent cast at all), both for a multi-candidate `.find()` merge and for
 * a paginated-primary fold whose `itemVar` keeps its real schema-inferred
 * type (no intervening `Record<string, unknown>` cast).
 */
const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

function rehostCapture(capture: Capture, host: string): Capture {
  const rehostedUrl = new URL(capture.url);
  rehostedUrl.host = host;
  return { ...capture, url: rehostedUrl.toString() };
}

function writeRunDir(root: string, captures: Capture[]): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));
  captures.forEach((capture, index) => {
    writeFileSync(
      join(root, "graphql", `${String(index).padStart(3, "0")}-capture.json`),
      JSON.stringify(capture)
    );
  });
}

function typecheckSite(siteId: string, tsconfigPath: string): string {
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
  return diagnostics;
}

let workDir: string | null = null;
let siteOutDir: string | null = null;
let tsconfigPath: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  if (tsconfigPath) rmSync(tsconfigPath, { force: true });
  workDir = null;
  siteOutDir = null;
  tsconfigPath = null;
});

describe("emitFoldMatchAndMergeLines merge object + response-schema cast — typecheck regression", () => {
  it("emits a fold-match merge whose nested join accessors typecheck with zero diagnostics", () => {
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }

    workDir = mkdtempSync(join(tmpdir(), "barnacle-foldmatch-merge-typing-"));
    const runRoot = join(workDir, "run");
    const host = "www.foldmatch-merge-typing-fixture.example.com";
    const captures = buildMulticallSingleShotSearchDrillDownNestedJoinFieldActionSteps().map(
      (step) => rehostCapture(step.capture, host)
    );
    writeRunDir(runRoot, captures);

    const siteId = `foldmatch-merge-typing-test-p${process.pid}x`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "search for entries" }, { step: "get entry details" }],
        ownBackendHostnames: [host],
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    // Confirms the merge object this regression targets was actually
    // emitted, not some unrelated branch that happens to also typecheck.
    expect(contract).toContain("Object.fromEntries(Object.entries(foldMatch");
    expect(contract).toContain("as Record<string, unknown>).sku");

    tsconfigPath = join(REPO_ROOT, `tsconfig.foldmatch-merge-typing.${process.pid}.json`);
    typecheckSite(siteId, tsconfigPath);
  }, 60_000);

  it("casts a fold+drill+submit chain's final response back to the plugin's own response type with zero diagnostics", () => {
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }

    // Unit-level: the emitted merge body always assigns THROUGH
    // Object.fromEntries against the untyped `Record<string, unknown>`
    // capture, never a bare property spread that would keep an implicit any.
    const steps = buildMulticallHeterogeneousActionStepsWithBookingSubmit().slice(0, 4);
    const body = emitMultiStepExecuteHttp(
      steps,
      null,
      { stringMessageKey: null, nestedErrorPaths: [] },
      new Map(),
      new Set(),
      new Map(),
      new Set(),
      new Map(),
      new Map(),
      "https://api.example.com",
      new Map(),
      new Map(),
      null,
      new Map(),
      new Map(),
      new Set(),
      [],
      new Map(),
      new Map(),
      null,
      "FoldMatchMergeTypingFixture"
    );
    expect(body).toContain("as unknown as FoldMatchMergeTypingFixtureResponse };");

    workDir = mkdtempSync(join(tmpdir(), "barnacle-foldmatch-response-cast-typing-"));
    const runRoot = join(workDir, "run");
    const host = "www.foldmatch-response-cast-typing-fixture.example.com";
    const captures = buildMulticallHeterogeneousActionStepsWithBookingSubmit().map((step) =>
      rehostCapture(step.capture, host)
    );
    writeRunDir(runRoot, captures);

    const siteId = `foldmatch-response-cast-typing-test-p${process.pid}x`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "authorize session" },
          { step: "browse paged facet search" },
          { step: "drill into unit availability" },
          { step: "book availability", submitStep: true },
        ],
        ownBackendHostnames: [host],
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contract).toContain("as unknown as");

    tsconfigPath = join(REPO_ROOT, `tsconfig.foldmatch-response-cast-typing.${process.pid}.json`);
    typecheckSite(siteId, tsconfigPath);
  }, 60_000);
});

const SEARCH_QUERY = "query jobSearch { jobSearch { postings { id title } } }";

function graphqlSearchCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:00Z",
    phase: "browse",
    method: "POST",
    url: "https://www.foldmatch-merge-object-typing-fixture.example.com/graphql",
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ query: SEARCH_QUERY, variables: {} }),
    responseHeaders: {},
    responseBody: {
      jobSearch: {
        postings: [
          { id: "job-1", title: "Engineer" },
          { id: "job-2", title: "Designer" },
        ],
      },
    },
    operationName: "jobSearch",
    query: SEARCH_QUERY,
    variables: {},
    decodedParams: null,
  };
}

// Two join-matched candidates per drill call (the real match plus a decoy
// sharing the request's own query param), forcing the `.find()` branch —
// each carrying a `location` field the primary item's own `{ id, title }`
// schema never declares.
function restDrillDownCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:01Z",
    phase: "browse",
    method: "GET",
    url: "https://www.foldmatch-merge-object-typing-fixture.example.com/listings/api/v1/openings?id=job-1",
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: {
      opening: [
        { id: "job-1", location: "Remote" },
        { id: "decoy-1", location: "WRONG" },
      ],
    },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

function writeGraphqlFoldRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));
  writeFileSync(
    join(root, "graphql", "000-browse-search.json"),
    JSON.stringify(graphqlSearchCapture())
  );
  writeFileSync(
    join(root, "graphql", "001-browse-drill.json"),
    JSON.stringify(restDrillDownCapture())
  );
}

function writeFoldReturnFlowFile(siteOutDir: string): void {
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({
      steps: [{ step: "search for jobs" }],
      foldReturn: {
        endpointPattern: "/listings/api/v1/openings",
        resultsPath: "jobSearch.postings",
        drillResultsPath: "opening",
        joinFields: ["id"],
      },
    })
  );
}

// Paginated-primary variant of the same trio hypothesis: `buildPaginatedGqlExecuteHttpBody`
// (recon-generate.ts:~9917) folds onto `itemsById`'s de-duplicated values with NO intervening
// `Record<string, unknown>` cast when the fold plan's primary array path exactly matches the
// detected pagination array path (residualPath.length === 0, recon-generate.ts:~10736-10767) —
// `itemVar` there keeps the REAL schema-inferred item type, not the loose cast every other fold
// branch gets. That still doesn't reproduce the trio: every inferred object schema in this
// codebase is emitted `.loose()` (recon-generate.ts's `inferZodSchema`), so `z.infer` already
// carries a `[key: string]: unknown` index signature on every level, and `emitFoldMatchAndMergeLines`'s
// `matchAccessorFor`/`unknownValueAccessor` both re-cast every intermediate hop to
// `Record<string, unknown>` regardless of the base var's own type — so a genuinely typed
// (non-index-signature) item never actually reaches a bare-bracket access.
function graphqlPaginatedSearchCapture(): unknown {
  const query =
    "query jobSearch($count: Int, $skip: Int) { jobSearch(count: $count, skip: $skip) { total postings { id title } } }";
  return {
    timestamp: "2024-01-01T00:00:00Z",
    phase: "browse",
    method: "POST",
    url: "https://www.foldmatch-paginate-typing-fixture.example.com/graphql",
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ query, variables: { count: 2, skip: 0 } }),
    responseHeaders: {},
    responseBody: {
      jobSearch: {
        total: 2,
        postings: [
          { id: "job-1", title: "Engineer" },
          { id: "job-2", title: "Designer" },
        ],
      },
    },
    operationName: "jobSearch",
    query,
    variables: { count: 2, skip: 0 },
    decodedParams: null,
  };
}

function restDrillDownCaptureForPagination(): unknown {
  return {
    timestamp: "2024-01-01T00:00:01Z",
    phase: "browse",
    method: "GET",
    url: "https://www.foldmatch-paginate-typing-fixture.example.com/listings/api/v1/openings?id=job-1",
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: {
      opening: [
        { id: "job-1", location: "Remote" },
        { id: "decoy-1", location: "WRONG" },
      ],
    },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

function writePaginatedRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));
  writeFileSync(
    join(root, "graphql", "000-browse-search.json"),
    JSON.stringify(graphqlPaginatedSearchCapture())
  );
  writeFileSync(
    join(root, "graphql", "001-browse-drill.json"),
    JSON.stringify(restDrillDownCaptureForPagination())
  );
}

describe("recon-generate CLI + tsc --noEmit — fold-match multi-candidate merge object typing", () => {
  it("emits a zero-diagnostic contract.ts for a multi-candidate foldReturn merge whose drill item widens the primary item's shape", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-foldmatch-merge-object-typing-"));
    const runRoot = join(workDir, "run");
    writeGraphqlFoldRunDir(runRoot);

    const siteId = `foldmatch-merge-object-typing-test${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    writeFoldReturnFlowFile(siteOutDir);

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contractPath = join(siteOutDir, "contract.ts");
    const contract = readFileSync(contractPath, "utf8");

    // The multi-candidate `.find()` branch of emitFoldMatchAndMergeLines,
    // not the flat single-object assign branch.
    expect(contract).toMatch(/foldMatches\w*\.find\(/);
    expect(contract).toMatch(/Object\.assign\(\w+, Object\.fromEntries\(/);

    tsconfigPath = join(REPO_ROOT, `tsconfig.foldmatch-merge-object-typing.${process.pid}.json`);
    typecheckSite(siteId, tsconfigPath);
  }, 30_000);

  it("emits a zero-diagnostic contract.ts for a paginated-primary foldReturn whose itemVar keeps the real schema-inferred type (no Record<string, unknown> cast)", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-foldmatch-paginate-typing-"));
    const runRoot = join(workDir, "run");
    writePaginatedRunDir(runRoot);

    const siteId = `foldmatch-paginate-typing-test${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    writeFoldReturnFlowFile(siteOutDir);

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contractPath = join(siteOutDir, "contract.ts");
    const contract = readFileSync(contractPath, "utf8");

    // Confirms the paginated loop actually ran (itemsById) and the fold
    // merge spliced in afterward with no intervening loose cast on `item`.
    expect(contract).toMatch(/itemsById/);
    expect(contract).toMatch(/\(foldItems\)\.map\(async \(item\) => \{/);
    expect(contract).toMatch(/Object\.assign\(item, Object\.fromEntries\(/);

    tsconfigPath = join(REPO_ROOT, `tsconfig.foldmatch-paginate-typing.${process.pid}.json`);
    typecheckSite(siteId, tsconfigPath);
  }, 30_000);
});
