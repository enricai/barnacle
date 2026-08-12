/**
 * Proves the mid-run telemetry attach point (Gap 1 of the run-telemetry plan:
 * a plugin needs to attach a field it only discovers during execute()/
 * executeHttp(), not just fields extractJoinKeys() can derive up front from
 * the inbound payload) is genuinely engine-level and site-agnostic — reached
 * by a plugin loaded from OUTSIDE the source tree, through the package's
 * published `SitePluginContext` type, not an internal shortcut only
 * in-tree plugins could take. This is a distinct guarantee from the
 * dispatch-internals coverage in loader.run-telemetry*.test.ts: those hand-
 * build a `SitePluginContext` and call `dispatch()` directly; this file goes
 * through the real `loadAllPlugins()` -> `registerRoutes()` -> HTTP chain an
 * operator's own out-of-tree plugin actually takes, and only imports types
 * from the package's declared `exports` subpaths.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import authPlugin from "@/api/plugins/auth";
import errorHandlerPlugin from "@/api/plugins/error-handler";
import type { AppConfig } from "@/config";
import { getLogger } from "@/lib/logging";
import { loadAllPlugins } from "@/plugins/discover";
import { registerRoutes } from "@/plugins/loader";

// Stub runWithSession so the fixture's browser-execute() path never needs a
// live Steel/Browserbase session — this suite only exercises execute().
vi.mock("@/scraper/pool", () => ({
  runWithSession: vi.fn().mockImplementation((task: (s: null) => Promise<unknown>) => task(null)),
}));

const mockCaptureSubmissionEnvelope = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/telemetry/submission-capture", () => ({
  captureSubmissionEnvelope: mockCaptureSubmissionEnvelope,
}));

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const TSC_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsc");
const FIXTURE_PATH = path.join(__dirname, "__fixtures__", "run-telemetry-oot-plugin.js");

const packageJson = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
  exports: Record<string, { default: string }>;
};

/** Matches a `tsc` CLI diagnostic line, e.g. `snippet.ts(3,11): error TS2339: ...`. */
const TSC_DIAGNOSTIC_LINE = /^.+\(\d+,\d+\): error (TS\d+): (.+)$/;

/**
 * Compiles a single source file as if it were sitting in a consumer's own
 * package, with `@enricai/barnacle/site-plugin` resolved to this repo's real
 * `src/site-plugin.ts` (matching the `./site-plugin` `exports` subpath) and
 * nothing else of `src/` reachable — an unexported type or member would
 * genuinely fail to resolve for a real out-of-tree consumer the same way it
 * fails here. Trimmed from `out-of-tree-e2e.test.ts`'s `typecheckGeneratedFiles`
 * (which additionally maps every declared `exports` subpath for recon-generate's
 * multi-file output) down to the one subpath this file's snippet needs.
 *
 * The scratch dir MUST live inside REPO_ROOT, not `os.tmpdir()` — Node's
 * bare-specifier resolution walks up from the checked files looking for
 * `node_modules`, and an os.tmpdir() path has none in its ancestry, so `zod/v4`
 * would fail to resolve and produce a false TS2307 unrelated to this file's
 * actual assertion (matches out-of-tree-e2e.test.ts's own precedent).
 */
function typecheckSnippet(source: string): Array<{ code: string; message: string }> {
  const tmpDir = mkdtempSync(path.join(REPO_ROOT, "barnacle-oot-telemetry-typecheck-"));
  try {
    const fileName = "snippet.ts";
    writeFileSync(path.join(tmpDir, fileName), source);

    const tsconfig = {
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        noEmit: true,
        // `@/*` resolves site-plugin.ts's OWN internal imports (@/config,
        // @/scraper/session, etc.) — those are src-internal, not part of the
        // consumer-facing surface this test guards, so they're mapped
        // permissively rather than gated like the exports subpath itself.
        paths: {
          "@enricai/barnacle/site-plugin": [path.join(REPO_ROOT, "src/site-plugin.ts")],
          "@/*": [path.join(REPO_ROOT, "src/*")],
        },
      },
      files: [fileName],
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

describe("out-of-tree plugin — SitePluginContext.telemetry.addJoinKeys is reachable from the published type", () => {
  /**
   * A plugin attaching a mid-run field has exactly one supported way to do
   * it: `context.telemetry.addJoinKeys()` on `SitePluginContext`
   * (docs/telemetry-and-judging.md's joinKeys section). If the collector
   * were wired internally but never surfaced on the exported type, this
   * source would fail with TS2339 ("Property 'telemetry' does not exist")
   * under the exports-gated harness above — the failure signal this suite
   * exists to guard, distinct from an unresolved import (TS2307), and
   * matching out-of-tree-e2e.test.ts's identical guard for
   * `recordBeaconOutcome`.
   */
  const addJoinKeysSource = `
import type { SitePluginContext } from "@enricai/barnacle/site-plugin";

export async function attachMidRunField(context: SitePluginContext): Promise<void> {
  context.telemetry.addJoinKeys({ discoveredToken: "abc-123" });
}
`;

  it("declares the SitePluginContext seam in package.json exports", () => {
    expect(packageJson.exports["./site-plugin"]).toBeDefined();
  });

  it("a plugin calling context.telemetry.addJoinKeys produces zero TS2307/TS2339 diagnostics", () => {
    const diagnostics = typecheckSnippet(addJoinKeysSource);
    const relevant = diagnostics.filter((d) => d.code === "TS2307" || d.code === "TS2339");
    expect(relevant.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
  });
});

describe("out-of-tree plugin — loadAllPlugins() -> registerRoutes() -> dispatch(): a mid-run attached field reaches the submission envelope", () => {
  const preservedEnv = {
    DEV_BYPASS_AUTH: process.env.DEV_BYPASS_AUTH,
    NODE_ENV: process.env.NODE_ENV,
  };

  const cfgStub = {
    scraper: { siteBaseUrls: {} },
    plugins: {
      specifiers: [FIXTURE_PATH],
      strict: false,
      baseDir: REPO_ROOT,
      configDir: undefined,
    },
  } as unknown as AppConfig;

  beforeEach(() => {
    process.env.DEV_BYPASS_AUTH = "true";
    process.env.NODE_ENV = "test";
    mockCaptureSubmissionEnvelope.mockClear();
  });

  afterEach(() => {
    if (preservedEnv.DEV_BYPASS_AUTH === undefined) delete process.env.DEV_BYPASS_AUTH;
    else process.env.DEV_BYPASS_AUTH = preservedEnv.DEV_BYPASS_AUTH;
    if (preservedEnv.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = preservedEnv.NODE_ENV;
    vi.clearAllMocks();
  });

  it("loadAllPlugins loads the fixture as a genuinely out-of-tree plugin (no core edits)", async () => {
    const { plugins, report } = await loadAllPlugins(cfgStub);

    const rec = report.find((r) => r.siteId === "run-telemetry-oot");
    expect(rec?.status).toBe("loaded");
    expect(rec?.specifier).toBe(FIXTURE_PATH);

    const plugin = plugins.find((p) => p.meta.siteId === "run-telemetry-oot");
    expect(plugin).toBeDefined();
  });

  it("a field attached via context.telemetry.addJoinKeys() during execute() lands in the emitted submission envelope's joinKeys", async () => {
    const { plugins } = await loadAllPlugins(cfgStub);

    const app = Fastify({ loggerInstance: getLogger({ name: "out-of-tree-run-telemetry-test" }) });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(errorHandlerPlugin);
    await app.register(authPlugin);
    await registerRoutes(app, cfgStub, plugins);
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/v1/run-telemetry-oot/run",
      payload: { query: "hello" },
    });

    await app.close();

    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body) as {
      status: { httpStatus: string };
      result: string;
    };
    expect(body.status.httpStatus).toBe("OK");
    expect(body.result).toBe("oot-telemetry-ok");

    expect(mockCaptureSubmissionEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        siteId: "run-telemetry-oot",
        status: "submitted",
        joinKeys: { discoveredToken: "mid-run-abc123" },
      })
    );
  });
});
