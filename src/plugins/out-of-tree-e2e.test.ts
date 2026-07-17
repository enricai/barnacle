import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import authPlugin from "@/api/plugins/auth";
import errorHandlerPlugin from "@/api/plugins/error-handler";
import type { AppConfig } from "@/config";
import { getLogger } from "@/lib/logging";
import { loadPlugins, type PluginLoadRecord } from "@/plugins/discover";
import { registerRoutes } from "@/plugins/loader";
import { emitBrowserFlowTs, emitContractTs, emitIndexTs } from "@/scripts/recon-generate";

// Stub runWithSession so the e2e test does not require a live Steel session.
vi.mock("@/scraper/pool", () => ({
  runWithSession: vi.fn().mockImplementation((task: (s: null) => Promise<unknown>) => task(null)),
}));

// Stub the audit-persistence sink so the test does not write to disk.
vi.mock("@/lib/telemetry/submission-capture", () => ({
  captureSubmissionEnvelope: vi.fn().mockResolvedValue(undefined),
}));

const FIXTURE_PATH = path.join(__dirname, "__fixtures__", "e2e-plugin.js");

const cfgStub = { scraper: { siteBaseUrls: {} } } as unknown as AppConfig;

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SITE_ID = "out-of-tree-demo";
const PASCAL = "OutOfTreeDemo";

const packageJson = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
  exports: Record<string, { default: string }>;
};

/**
 * Resolution for `@enricai/barnacle/*` restricted to exactly the subpaths the
 * package declares in `exports` — mirrors what an installed npm package offers
 * a consumer, so an emitted import to an undeclared subpath fails exactly like
 * it would out-of-tree, not merely because src/ happens to have the file.
 *
 * Keyed by package name rather than the `@/` alias because that is what the
 * emitter now writes: `tsc-alias` rewrites `@/` by text and cannot tell an
 * import the emitter *uses* from one it *emits as a string*, so an emitted
 * alias arrives at consumers as a broken relative path (see ENGINE_PKG in
 * recon-generate.ts). `@/sites/*` stays out of this map — it is the consumer's
 * OWN generated tree, not part of the installed package's surface.
 */
function buildExportsPathsMap(): Record<string, string[]> {
  const paths: Record<string, string[]> = {};
  for (const [subpath, target] of Object.entries(packageJson.exports)) {
    if (subpath === "." || subpath === "./package.json") continue;
    // dist/foo/bar.js -> src/foo/bar.ts
    const srcRelative = target.default.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ".ts");
    paths[`@enricai/barnacle/${subpath.replace(/^\.\//, "")}`] = [
      path.join(REPO_ROOT, srcRelative),
    ];
  }
  return paths;
}

const TSC_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsc");

/** Matches a `tsc` CLI diagnostic line, e.g. `contract.ts(12,34): error TS2307: ...`. */
const TSC_DIAGNOSTIC_LINE = /^.+\(\d+,\d+\): error (TS\d+): (.+)$/;

/**
 * Runs the real TypeScript compiler (via the repo's own `tsc` CLI, in a child
 * process — the `typescript` package's in-process `ts.createProgram` API is
 * unavailable under the pinned `typescript@7` native-preview build) against
 * the generated plugin files as if they were sitting in a consumer's own src/
 * tree — `@/sites/*` resolves to the consumer's own out-of-tree module, every
 * other `@/*` resolves ONLY to the subpaths the package's `exports` map
 * declares (see buildExportsPathsMap), and `bottleneck`/`zod` resolve as
 * ordinary node_modules packages (declared dependencies of this repo,
 * standing in for the consumer having run the emitted checklist's
 * `pnpm add bottleneck zod`).
 */
function typecheckGeneratedFiles(
  files: Record<string, string>
): Array<{ code: string; message: string }> {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "barnacle-oot-typecheck-"));
  try {
    for (const [relPath, content] of Object.entries(files)) {
      const absPath = path.join(tmpDir, relPath);
      mkdirSync(path.dirname(absPath), { recursive: true });
      writeFileSync(absPath, content);
    }

    const tsconfig = {
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noUncheckedIndexedAccess: true,
        esModuleInterop: true,
        skipLibCheck: true,
        noEmit: true,
        baseUrl: ".",
        paths: {
          "@/sites/*": ["./sites/*"],
          ...buildExportsPathsMap(),
        },
      },
      files: Object.keys(files),
    };
    writeFileSync(path.join(tmpDir, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));

    const result = spawnSync(TSC_BIN, ["-p", "tsconfig.json"], { cwd: tmpDir, encoding: "utf8" });
    const output = `${result.stdout}\n${result.stderr}`;
    const diagnostics: Array<{ code: string; message: string }> = [];
    for (const line of output.split("\n")) {
      const match = line.match(TSC_DIAGNOSTIC_LINE);
      if (match?.[1] === undefined || match[2] === undefined) continue;
      diagnostics.push({ code: match[1], message: match[2] });
    }
    return diagnostics;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Rewrites a generated file's import specifiers to absolute, extensioned file
 * paths so Node's native TS type-stripping loader (no bundler, no
 * tsconfig-paths support, and no installed copy of this package to resolve its
 * own name against) can `import()` it directly — standing in for whatever
 * install/bundling step turns a consumer's source into a loadable module.
 *
 * Two specifier shapes, because the emitted file legitimately carries both:
 * `@enricai/barnacle/<subpath>` is the ENGINE, resolved against this package's
 * real source and gated to only the subpaths declared in `exports` (mirroring
 * buildExportsPathsMap); `@/sites/<siteId>/...` is the CONSUMER's own generated
 * tree, resolved to the sibling temp file.
 */
function resolveAliasImports(source: string, siteDir: string): string {
  const exportsToSrc = new Map(
    Object.entries(packageJson.exports)
      .filter(([subpath]) => subpath !== "." && subpath !== "./package.json")
      .map(([subpath, target]) => [
        subpath.replace(/^\.\//, ""),
        target.default.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ".ts"),
      ])
  );
  const withEngine = source.replace(
    /from "@enricai\/barnacle\/([^"]+)"/g,
    (match, specifier: string) => {
      const srcRelative = exportsToSrc.get(specifier);
      if (!srcRelative) return match;
      return `from ${JSON.stringify(pathToFileURL(path.join(REPO_ROOT, srcRelative)).href)}`;
    }
  );
  return withEngine.replace(/from "@\/([^"]+)"/g, (match, specifier: string) => {
    if (specifier.startsWith(`sites/${SITE_ID}/`)) {
      const rel = specifier.slice(`sites/${SITE_ID}/`.length);
      return `from ${JSON.stringify(pathToFileURL(path.join(siteDir, `${rel}.ts`)).href)}`;
    }
    return match;
  });
}

describe("out-of-tree e2e — recon-generate output typechecks against the package's public export surface", () => {
  const browserFlow = emitBrowserFlowTs({
    siteId: SITE_ID,
    pascal: PASCAL,
    baseUrl: "https://example.com",
    isSubmissionFlow: false,
    flowSteps: ["Open the results list"],
  });

  const contractSource = emitContractTs({
    siteId: SITE_ID,
    pascal: PASCAL,
    baseUrl: "https://example.com",
    baseHeaders: { "Content-Type": "application/json" },
    minTime: 100,
    safeRps: 10,
    responseBody: { id: "abc", active: true },
    gql: false,
    gqlQuery: null,
    endpointPath: "/api/search",
    auxFiles: [],
    inputBody: undefined,
    payloadFieldNames: browserFlow.payloadFieldNames,
  });

  const indexSource = emitIndexTs({ siteId: SITE_ID, pascal: PASCAL });

  const files = {
    [`sites/${SITE_ID}/contract.ts`]: contractSource,
    [`sites/${SITE_ID}/flows/browser-flow.ts`]: browserFlow.code,
    [`sites/${SITE_ID}/index.ts`]: indexSource,
  };

  /**
   * Four of the contract's engine imports are conditional — `multipartBoolean`
   * and `omitHeaderCaseInsensitive` on `hasMultipartStep`, `loadFixture` on
   * `auxFiles`, `createGraphqlClient` on `gql` — so the fixture above, which
   * takes none of those branches, cannot see them. This variant takes all four,
   * and exists solely so the import guards inspect every specifier the emitter
   * can produce rather than the subset one fixture happens to reach.
   */
  const allBranchesContract = emitContractTs({
    siteId: SITE_ID,
    pascal: PASCAL,
    baseUrl: "https://example.com",
    baseHeaders: { "Content-Type": "application/json" },
    minTime: 100,
    safeRps: 10,
    responseBody: { id: "abc" },
    gql: true,
    gqlQuery: "query Search { results { id } }",
    endpointPath: "/graphql",
    auxFiles: ["markets.json"],
    hasMultipartStep: true,
    inputBody: { Name: "Alice" },
    payloadFieldNames: browserFlow.payloadFieldNames,
    multiStepBody: `    return { data: {} as unknown };`,
  });

  /** Every emitted source the import guards must cover. */
  const emittedSources = [...Object.values(files), allBranchesContract];

  it("resolves ./scraper/http-client from the package's exports map", () => {
    expect(packageJson.exports["./scraper/http-client"]).toBeDefined();
  });

  it("emits no engine @/ alias — only the consumer's own @/sites/*", () => {
    // Guards the cause, not the symptom. An emitted `@/` engine alias survives
    // src/ review and every source-level assertion, then tsc-alias rewrites it
    // to a relative path inside the template literal at build time and every
    // consumer gets TS2307. Asserting the emitters' in-process output catches
    // that without needing a build — `pnpm test` never runs `pnpm run build`.
    const engineAliases = emittedSources
      .flatMap((source) => Array.from(source.matchAll(/from "(@\/[^"]+)"/g), (m) => m[1] as string))
      .filter((alias) => !alias.startsWith(`@/sites/`));
    expect(engineAliases).toEqual([]);
  });

  it("emits every engine import from a declared exports subpath", () => {
    const declared = new Set(
      Object.keys(packageJson.exports)
        .filter((s) => s !== "." && s !== "./package.json")
        .map((s) => s.replace(/^\.\//, ""))
    );
    const emitted = emittedSources.flatMap((source) =>
      Array.from(source.matchAll(/@enricai\/barnacle\/([^"']+)/g), (m) => m[1] as string)
    );
    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted.filter((s) => !declared.has(s))).toEqual([]);
  });

  it("produces zero TS2307 (cannot find module) and TS2532 (possibly undefined) diagnostics", () => {
    const diagnostics = typecheckGeneratedFiles(files);
    const relevant = diagnostics.filter((d) => d.code === "TS2307" || d.code === "TS2532");
    expect(relevant.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
  });

  it("loadPlugins resolves the generated contract.ts via m.plugin ?? m.default ?? m — no silent 404", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "barnacle-oot-load-"));
    try {
      const siteDir = path.join(tmpDir, "sites", SITE_ID);
      mkdirSync(path.join(siteDir, "flows"), { recursive: true });
      writeFileSync(
        path.join(siteDir, "contract.ts"),
        resolveAliasImports(contractSource, siteDir)
      );
      writeFileSync(
        path.join(siteDir, "flows", "browser-flow.ts"),
        resolveAliasImports(browserFlow.code, siteDir)
      );
      const indexPath = path.join(siteDir, "index.ts");
      writeFileSync(indexPath, resolveAliasImports(indexSource, siteDir));

      const { plugins, report } = await loadPlugins([indexPath], {
        baseDir: tmpDir,
        strict: true,
        seenSiteIds: new Set(),
      });

      expect(report[0]?.status).toBe("loaded");
      expect(plugins).toHaveLength(1);
      expect(plugins[0]?.meta.siteId).toBe(SITE_ID);
      expect(plugins[0]?.meta.apiVersion).toBe("1.0.0");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("out-of-tree plugin — end-to-end: loadPlugins → registerRoutes → /run", () => {
  const preservedEnv = {
    DEV_BYPASS_AUTH: process.env.DEV_BYPASS_AUTH,
    NODE_ENV: process.env.NODE_ENV,
  };

  beforeEach(() => {
    process.env.DEV_BYPASS_AUTH = "true";
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    if (preservedEnv.DEV_BYPASS_AUTH === undefined) delete process.env.DEV_BYPASS_AUTH;
    else process.env.DEV_BYPASS_AUTH = preservedEnv.DEV_BYPASS_AUTH;
    if (preservedEnv.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = preservedEnv.NODE_ENV;
    vi.clearAllMocks();
  });

  it("loadPlugins returns one loaded plugin and a loaded report record for the e2e fixture", async () => {
    const { plugins, report } = await loadPlugins([FIXTURE_PATH], {
      baseDir: process.cwd(),
      strict: false,
      seenSiteIds: new Set(),
    });

    expect(plugins).toHaveLength(1);
    expect(report).toHaveLength(1);

    const rec = report[0] as PluginLoadRecord;
    expect(rec.status).toBe("loaded");
    expect(rec.siteId).toBe("e2e-plugin");
    expect(rec.displayName).toBe("E2E Out-of-Tree Plugin");
    expect(rec.route).toBe("/v1/e2e-plugin/run");
  });

  it("POST /v1/e2e-plugin/run returns 200 with a standard success envelope carrying the plugin's canned data", async () => {
    const { plugins } = await loadPlugins([FIXTURE_PATH], {
      baseDir: process.cwd(),
      strict: false,
      seenSiteIds: new Set(),
    });

    const app = Fastify({ loggerInstance: getLogger({ name: "e2e-test" }) });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(errorHandlerPlugin);
    await app.register(authPlugin);
    await registerRoutes(app, cfgStub, plugins);
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/v1/e2e-plugin/run",
      payload: { query: "test" },
    });

    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body) as {
      status: { httpStatus: string; dateTime: string; details: unknown[] };
      result: string;
    };
    expect(body.status.httpStatus).toBe("OK");
    expect(body.status.details).toEqual([]);
    expect(body.result).toBe("e2e-ok");

    await app.close();
  });
});
