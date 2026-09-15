import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Pins the report's remaining `TS7053`/`TS18046`/`TS2740` trio: a
 * single-primary GraphQL query with a declared `foldReturn` (the
 * `emitContractTs` "getGql/httpClient fold-merge" hot path —
 * `dataFoldMergeBlock; return { data };`, recon-generate.ts:~11030 — which,
 * unlike {@link emitMultiStepExecuteHttp}'s `castToResponseType`-wrapped
 * `return { data }`, emits `data` with NO subsequent cast at all) whose
 * drill response holds TWO join-matched candidates (forcing
 * `emitFoldMatchAndMergeLines`'s `foldMatches${suffix}.find(...)` branch)
 * and carries a field (`location`) absent from the primary item's own
 * inferred schema — the shape `Object.assign` grafts onto the item at
 * runtime without ever updating its static type, so the merged field stays
 * invisible to tsc. Modeled on the "resolves a fold plan..." case in
 * recon-generate-graphql-primary-get-drilldown-fold-runtime-e2e.test.ts,
 * but driven through the full CLI + `tsc --noEmit` like
 * recon-generate-1-12-50-typecheck-and-fold-drill-name-correlation-e2e.test.ts,
 * which no existing `foldReturn`+GraphQL fixture does.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

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

function writeRunDir(root: string): void {
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

function writeFlowFile(siteOutDir: string): void {
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
    writeRunDir(runRoot);

    const siteId = `foldmatch-merge-object-typing-test${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    writeFlowFile(siteOutDir);

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
    const referencesEmittedFile = diagnostics.includes("contract.ts");
    expect(referencesEmittedFile, diagnostics).toBe(false);
    expect(check.status, diagnostics).toBe(0);
  }, 30_000);

  it("emits a zero-diagnostic contract.ts for a paginated-primary foldReturn whose itemVar keeps the real schema-inferred type (no Record<string, unknown> cast)", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-foldmatch-paginate-typing-"));
    const runRoot = join(workDir, "run");
    writePaginatedRunDir(runRoot);

    const siteId = `foldmatch-paginate-typing-test${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    writeFlowFile(siteOutDir);

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
    expect(contract).toMatch(/for \(const item of foldItems\)/);
    expect(contract).toMatch(/Object\.assign\(item, Object\.fromEntries\(/);

    tsconfigPath = join(REPO_ROOT, `tsconfig.foldmatch-paginate-typing.${process.pid}.json`);
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
    const referencesEmittedFile = diagnostics.includes("contract.ts");
    expect(referencesEmittedFile, diagnostics).toBe(false);
    expect(check.status, diagnostics).toBe(0);
  }, 30_000);
});
