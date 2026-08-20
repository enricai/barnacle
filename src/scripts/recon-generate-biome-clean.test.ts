import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { emitContractTs, emitMultiStepExecuteHttp } from "@/scripts/recon-generate";
import type { Capture } from "@/scripts/recon-shared";

/** Resolve the Biome binary from the repo's own `node_modules/.bin` rather than
 * bare PATH — matches the sibling binary-invoking tests (recon-browser.build.test.ts)
 * and survives runner invocations that don't prepend `.bin` to PATH. */
const BIOME_BIN = resolve(__dirname, "..", "..", "node_modules", ".bin", "biome");

const REPO_ROOT = resolve(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

/**
 * The emitter's output ships to a consumer's `src/sites/<id>/contract.ts`, which
 * is linted with Biome's default rules — so the generated code must be
 * lint-clean. Two regressions previously escaped BECAUSE no test linted emitter
 * output: (A) `noNonNullAssertion` from a `!` on produce-extraction accessors,
 * and (B) `noUnusedVariables` from a `const rN = await httpClient(...)` bound
 * but never read (a produce whose name an earlier step already declared forced
 * the binding while its extraction line was de-dup-skipped). This locks both.
 */

function cap(o: {
  url: string;
  requestPostData: string | null;
  responseBody: unknown;
  ts: string;
}): Capture {
  return {
    timestamp: o.ts,
    phase: "action",
    method: "POST",
    url: o.url,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: o.requestPostData,
    responseHeaders: { "content-type": "application/json" },
    responseBody: o.responseBody,
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

/** The emitter's real parameter type is the unexported `ActionStep[]`; every
 * consuming test casts through the exported function's own parameter type. */
type EmitSteps = Parameters<typeof emitMultiStepExecuteHttp>[0];

function emit(steps: unknown): string {
  return emitMultiStepExecuteHttp(
    steps as EmitSteps,
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
    new Map()
  );
}

/**
 * Bug A: a step produces a value at a NUMERIC-key path
 * (`data["221"].label`) that a later step's body re-sends, so the emitter writes
 * a `const label = (r0 as {...})...` extraction. Pre-fix that accessor carried a
 * trailing `!` on the `["221"]` bracket segment.
 */
function bugAExtractionSteps(): unknown[] {
  const value221 = "LABEL-VALUE-221-abcdefghijklmnop";
  return [
    {
      varName: "r0",
      produces: [{ kind: "body", name: "label", path: ["data", "221", "label"] }],
      isMultipart: false,
      isCrossDomain: false,
      capture: cap({
        url: "https://api.example.com/getReferences",
        requestPostData: "{}",
        responseBody: { data: { "221": { label: value221 } } },
        ts: "2024-01-01T00:00:00Z",
      }),
    },
    {
      varName: "r1",
      produces: [],
      isMultipart: false,
      isCrossDomain: false,
      capture: cap({
        url: "https://api.example.com/submit",
        requestPostData: JSON.stringify({ ref: value221 }),
        responseBody: { success: true },
        ts: "2024-01-01T00:00:01Z",
      }),
    },
  ];
}

/**
 * Bug B: r0 and r1 both produce a value named `token` (a re-auth returning a
 * fresh token). The downstream step consumes `token`, so the name is referenced;
 * r0 declares `const token = ...` and r1's extraction is de-dup-skipped. Pre-fix
 * r1 was still bound (`const r1 = await httpClient(...)`) yet never read.
 */
function bugBDeadBindingSteps(): unknown[] {
  const token0 = "TOKEN-VALUE-ZERO-abcdefghijklmnop";
  const token1 = "TOKEN-VALUE-ONE-abcdefghijklmnop";
  return [
    {
      varName: "r0",
      produces: [{ kind: "body", name: "token", path: ["token"] }],
      isMultipart: false,
      isCrossDomain: false,
      capture: cap({
        url: "https://api.example.com/auth1",
        requestPostData: "{}",
        responseBody: { token: token0 },
        ts: "2024-01-01T00:00:00Z",
      }),
    },
    {
      varName: "r1",
      produces: [{ kind: "body", name: "token", path: ["token"] }],
      isMultipart: false,
      isCrossDomain: false,
      capture: cap({
        url: "https://api.example.com/auth2",
        requestPostData: "{}",
        responseBody: { token: token1 },
        ts: "2024-01-01T00:00:01Z",
      }),
    },
    {
      varName: "r2",
      produces: [],
      isMultipart: false,
      isCrossDomain: false,
      capture: cap({
        url: "https://api.example.com/submit",
        requestPostData: JSON.stringify({ auth: token0 }),
        responseBody: { success: true },
        ts: "2024-01-01T00:00:02Z",
      }),
    },
  ];
}

/** Deterministic, offline structural guard for the two shipped regressions. */
function assertPatternsClean(body: string): void {
  expect(body, "emitted a non-null assertion on a bracket accessor").not.toMatch(/\]!/);
  for (const m of body.matchAll(/const (r\d+) =/g)) {
    const name = m[1]!;
    const uses = body.match(new RegExp(`\\b${name}\\b`, "g")) ?? [];
    expect(uses.length, `${name} is bound but referenced only once (dead binding)`).toBeGreaterThan(
      1
    );
  }
}

describe("emitMultiStepExecuteHttp — emitted code is Biome-clean", () => {
  it("emits produce extractions with no non-null assertion (Bug A)", () => {
    const body = emit(bugAExtractionSteps());
    expect(body).toContain("const label = (r0 as");
    expect(body).toContain('.data["221"].label;');
    assertPatternsClean(body);
  });

  it("does not bind a response whose only produce was de-dup-skipped (Bug B)", () => {
    const body = emit(bugBDeadBindingSteps());
    // r1's `token` extraction is de-dup-skipped (r0 declared it) and r1 is used
    // nowhere else, so r1 must be emitted as a bare `await httpClient(...)`, not
    // `const r1 = (await httpClient(...))`.
    const auth2Line = body.split("\n").find((l) => l.includes("/auth2"));
    expect(auth2Line?.trimStart()).toMatch(/^await httpClient\(/);
    expect(body).not.toContain("const r1 = (await httpClient");
    assertPatternsClean(body);
  });

  /**
   * Highest-fidelity guard: run the real Biome binary against the emitted body
   * with the two rules explicitly enabled as errors (the repo's own
   * `src/scripts/**` override disables `noNonNullAssertion`, which is why the
   * body is written to an out-of-repo tmp dir with an explicit config instead).
   */
  it("passes `biome lint` for both fixtures", () => {
    if (!existsSync(BIOME_BIN)) {
      throw new Error(`biome binary not found at ${BIOME_BIN} — run pnpm install`);
    }
    const preamble = [
      "async function executeHttp(",
      "  httpClient: (url: string, init: unknown) => Promise<unknown>,",
      "  payload: Record<string, unknown>,",
      "): Promise<{ data: unknown }> {",
      "  const z = { object: (_: unknown) => ({}), string: () => ({}), boolean: () => ({}), number: () => ({}), array: (_: unknown) => ({}) };",
      "  void z;",
    ].join("\n");

    const dir = mkdtempSync(join(tmpdir(), "barnacle-biome-"));
    try {
      writeFileSync(
        join(dir, "biome.json"),
        JSON.stringify({
          $schema: "https://biomejs.dev/schemas/2.3.11/schema.json",
          // Formatter/assist off: this test guards the two LINT regressions, not
          // whitespace — the emitter's own formatting is covered elsewhere.
          formatter: { enabled: false },
          assist: { enabled: false },
          linter: {
            enabled: true,
            rules: {
              recommended: false,
              correctness: { noUnusedVariables: "error" },
              style: { noNonNullAssertion: "error" },
            },
          },
        })
      );

      for (const [label, steps] of [
        ["bugA", bugAExtractionSteps()],
        ["bugB", bugBDeadBindingSteps()],
      ] as const) {
        const file = join(dir, `${label}.ts`);
        writeFileSync(file, `${preamble}\n${emit(steps)}\n}\nvoid executeHttp;\n`);
        // execFileSync throws on non-zero exit; a lint error would fail the test
        // with Biome's diagnostic captured in the thrown error's stdout.
        expect(() =>
          execFileSync(BIOME_BIN, ["lint", "--config-path", dir, file], {
            cwd: dir,
            encoding: "utf8",
            stdio: "pipe",
          })
        ).not.toThrow();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * G2's own uncomment instruction claims the emitted `// const ... =
 * loadFixture(...)` line is valid JS once stripped of its leading `// `.
 * Regex-checking the identifier shape (recon-generate-fixture-identifier.test.ts)
 * proves the name is well-formed but not that the whole line parses — this
 * closes that gap by running it through the real Biome parser.
 */
describe("emitContractTs — uncommented loadFixture lines parse (G2)", () => {
  it("parses cleanly once every `// const ... = loadFixture(...)` line is uncommented", () => {
    if (!existsSync(BIOME_BIN)) {
      throw new Error(`biome binary not found at ${BIOME_BIN} — run pnpm install`);
    }

    const source = emitContractTs({
      siteId: "test-site",
      pascal: "TestSite",
      baseUrl: "https://example.com",
      baseHeaders: { "Content-Type": "application/json" },
      minTime: 100,
      safeRps: 10,
      responseBody: { id: "abc", active: true },
      gql: false,
      gqlQuery: null,
      endpointPath: "/api/search",
      hasMultipartStep: false,
      auxFiles: [
        "10219132.json",
        "vendorwidget.config-a.example-net.json",
        "acme-domains-configuration.json",
      ],
    });
    const uncommented = source
      .split("\n")
      .filter((line) => line.trimStart().startsWith("// const ") && line.includes("loadFixture("))
      .map((line) => line.trimStart().replace(/^\/\/ /, ""));
    expect(uncommented.length).toBe(3);

    const snippet = [
      "declare function loadFixture(siteId: string, filename: string, schema: unknown): unknown;",
      "declare const z: { unknown: () => unknown };",
      ...uncommented,
    ].join("\n");

    const dir = mkdtempSync(join(tmpdir(), "barnacle-biome-"));
    try {
      // No rules enabled — Biome still parses the file before applying any
      // rule, so a parse error (the exact G2 "uncomment and it breaks"
      // scenario) surfaces as a diagnostic and a non-zero exit regardless.
      writeFileSync(
        join(dir, "biome.json"),
        JSON.stringify({
          $schema: "https://biomejs.dev/schemas/2.3.11/schema.json",
          formatter: { enabled: false },
          assist: { enabled: false },
          linter: { enabled: true, rules: { recommended: false } },
        })
      );
      const file = join(dir, "fixtures.ts");
      writeFileSync(file, `${snippet}\n`);
      expect(() =>
        execFileSync(BIOME_BIN, ["lint", "--config-path", dir, file], {
          cwd: dir,
          encoding: "utf8",
          stdio: "pipe",
        })
      ).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Extracts the body of the emitted `executeHttp` method from a generated
 * contract.ts by locating its opening `Promise<SitePluginResult<...>> {`
 * signature line and its closing `  },` — `emitContractTs`'s helpers aren't
 * exported, so the body is read back out of the CLI's own file output rather
 * than re-invoked in isolation. */
function extractExecuteHttpBody(contract: string): string {
  const start = contract.indexOf("async executeHttp(");
  if (start === -1) throw new Error("contract.ts has no executeHttp method");
  const signatureEnd = contract.indexOf("{", contract.indexOf(">>", start));
  const bodyStart = contract.indexOf("\n", signatureEnd) + 1;
  const bodyEnd = contract.indexOf("\n  },\n", bodyStart);
  if (bodyEnd === -1) throw new Error("could not locate end of executeHttp body");
  return contract.slice(bodyStart, bodyEnd);
}

/** A run dir whose primary operation's response exposes a total alongside a
 * skip+count pagination variable — the bounded-paging signal that drives
 * `buildPaginatedGqlExecuteHttpBody`'s merge/return construction. */
function writePagedRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });

  const capture = {
    timestamp: "2026-08-18T10:23:03.000Z",
    phase: "browse-the-catalog",
    method: "POST",
    url: "https://www.catalog-fixture.example.com/catalog/graph",
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: "{}",
    responseHeaders: {},
    operationName: "catalogSearch_Items",
    query:
      "query catalogSearch_Items($pagination: PaginationInput) { search(pagination: $pagination) { total items { id title } } }",
    variables: { pagination: { count: 5, skip: 0 }, sort: "RELEVANCE" },
    responseBody: {
      search: {
        total: 15,
        items: Array.from({ length: 5 }, (_, i) => ({ id: `item-${i}`, title: `Item ${i}` })),
      },
    },
    decodedParams: null,
  };

  writeFileSync(
    join(root, "graphql", "000-browse-the-catalog-action.json"),
    JSON.stringify(capture)
  );
}

/**
 * H2: the paginated fetch loop's merge/return construction previously
 * narrowed `lastPage` with a non-null assertion (`lastPage!`) that propagated
 * into every spread path built off it, tripping `noNonNullAssertion` in any
 * consumer that enables the rule. The template now declares `lastPage` from
 * the always-executed first-page fetch (never `null`), so no narrowing is
 * needed. This locks both the structural absence of `!` and a real Biome
 * lint pass, matching the technique in the describe block above.
 */
describe("recon-generate GraphQL paginated fetch loop — emitted merge step is Biome-clean (H2)", () => {
  let workDir: string | null = null;
  let siteOutDir: string | null = null;

  afterEach(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
    if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
    workDir = null;
    siteOutDir = null;
  });

  it("emits a merge/return construction with zero non-null assertions and passes `biome lint`", () => {
    if (!existsSync(BIOME_BIN)) {
      throw new Error(`biome binary not found at ${BIOME_BIN} — run pnpm install`);
    }

    workDir = mkdtempSync(join(tmpdir(), "barnacle-paginated-biome-clean-"));
    const runRoot = join(workDir, "run");
    writePagedRunDir(runRoot);

    const siteId = `paginated-biome-clean-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    const body = extractExecuteHttpBody(contract);

    // The 4 warnings this locks were all `lastPage!` occurrences, plus the
    // spread paths built off it.
    expect(body).not.toMatch(/lastPage!/);
    // General sweep: no non-null assertion on any identifier anywhere in the
    // merge/return construction.
    expect(body).not.toMatch(/\w!(?:[.[]|\s*(?:as|;))/);

    const preamble = [
      "interface GqlResponse { search: { total: number; items: unknown[] } }",
      "async function executeHttp(",
      "  _payload: Record<string, unknown>,",
      "  context: { baseUrl: string },",
      "): Promise<{ data: GqlResponse }> {",
      "  const getGql = (_baseUrl: string) => async (",
      "    _op: string,",
      "    _query: string,",
      "    _vars: unknown,",
      "  ): Promise<GqlResponse> => ({ search: { total: 0, items: [] } });",
      "  void getGql;",
    ].join("\n");

    const dir = mkdtempSync(join(tmpdir(), "barnacle-biome-"));
    try {
      writeFileSync(
        join(dir, "biome.json"),
        JSON.stringify({
          $schema: "https://biomejs.dev/schemas/2.3.11/schema.json",
          formatter: { enabled: false },
          assist: { enabled: false },
          linter: {
            enabled: true,
            rules: {
              recommended: false,
              style: { noNonNullAssertion: "error" },
            },
          },
        })
      );

      const file = join(dir, "paginated-merge.ts");
      writeFileSync(
        file,
        `${preamble}\n${body.replace(/: \w+Response\b/g, ": GqlResponse")}\n}\nvoid executeHttp;\n`
      );
      expect(() =>
        execFileSync(BIOME_BIN, ["lint", "--config-path", dir, file], {
          cwd: dir,
          encoding: "utf8",
          stdio: "pipe",
        })
      ).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
