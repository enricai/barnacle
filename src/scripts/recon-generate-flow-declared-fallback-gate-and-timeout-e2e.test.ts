import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RunTelemetry } from "@/lib/telemetry/run-telemetry";
import { HttpBotChallengeError, HttpSchemaError } from "@/scraper/errors";
import type { SitePlugin, SitePluginContext } from "@/site-plugin";

/**
 * End-to-end pin for recon-flow.json's declarable `browserFallbackGate` /
 * `httpTimeoutMs` keys ({@link import("@/scripts/recon-generate").parseFallbackGateSpec}):
 * a fixture declares them, the real CLI generates a contract.ts from that
 * fixture, and the generated module is loaded and run through the real
 * `dispatch()` pipeline (mirroring `src/plugins/loader.test.ts`'s
 * "browserFallbackGate" suite) to prove the gate the generator emits
 * actually changes hot-path-failure routing at runtime — not merely that
 * the right substring appears in the generated source.
 */

const mockCaptureSubmissionEnvelope = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockRunWithSession = vi.hoisted(() =>
  vi.fn().mockImplementation((task: (s: null) => Promise<unknown>) => task(null))
);

vi.mock("@/scraper/pool", () => ({
  runWithSession: mockRunWithSession,
}));

vi.mock("@/lib/telemetry/submission-capture", () => ({
  captureSubmissionEnvelope: mockCaptureSubmissionEnvelope,
}));

vi.mock("@/lib/tracking-click", () => ({
  fireTrackingClick: vi.fn(),
}));

vi.mock("@/lib/telemetry/beacon-capture", () => ({
  captureBeaconEvent: vi.fn().mockResolvedValue(undefined),
  createBeaconOutcomeRecorder: vi.fn(() => vi.fn().mockResolvedValue(undefined)),
}));

vi.mock("@/lib/dd-metrics", () => ({
  recordDdAttempt: vi.fn(),
  recordDdSuccess: vi.fn(),
  recordDdFailure: vi.fn(),
  recordDdDuration: vi.fn(),
  recordDdFallback: vi.fn(),
  recordDdRateLimit: vi.fn(),
}));

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

function writeRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));
  writeFileSync(
    join(root, "graphql", "000-search.json"),
    JSON.stringify({
      timestamp: "2024-01-01T00:00:00Z",
      phase: "home",
      method: "POST",
      url: "https://example.com/api/search",
      status: 200,
      requestHeaders: { "Content-Type": "application/json" },
      requestPostData: JSON.stringify({ query: "widgets" }),
      responseHeaders: { "content-type": "application/json" },
      responseBody: { id: "abc", active: true },
      operationName: null,
      query: null,
      variables: null,
      decodedParams: null,
    })
  );
}

let workDir: string | null = null;
let siteOutDir: string | null = null;
const siteId = `flowdeclaredgatetimeoute2e${process.pid}`;

beforeEach(() => {
  mockCaptureSubmissionEnvelope.mockResolvedValue(undefined);
  mockRunWithSession.mockImplementation((task: (s: null) => Promise<unknown>) => task(null));
});

afterEach(() => {
  vi.clearAllMocks();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-flow.json-declared browserFallbackGate/httpTimeoutMs — generator + runtime pipeline", () => {
  it("emits a gate that allows fallback for the declared class and blocks it for others, and threads the declared timeout onto the hot-path client", async () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-flow-declared-gate-timeout-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "search for widgets" }],
        browserFallbackGate: ["HttpSchemaError"],
        httpTimeoutMs: 4321,
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contractPath = join(siteOutDir, "contract.ts");
    const contractSource = readFileSync(contractPath, "utf8");
    // The declared per-call timeout override reaches createHttpClient's
    // defaultTimeoutMs — the "appropriate field" for a hot-path HTTP call
    // timeout (browserFallbackTaskTimeoutMs governs the browser fallback's
    // own task budget, a distinct concern from the HTTP client's timeout).
    expect(contractSource).toContain("defaultTimeoutMs: 4321");

    // The generated file imports via the package's own public "@enricai/barnacle/..."
    // specifiers — resolvable once `dist/` is built for a real out-of-tree
    // consumer, but not in this unbuilt worktree. Rewriting to the in-repo
    // "@/..." alias here (only in the throwaway generated copy under test,
    // never in the source `emitContractTs` template) lets the test import
    // and execute the SAME generated meta/gate without requiring a build.
    writeFileSync(contractPath, contractSource.replaceAll("@enricai/barnacle/", "@/"));
    const browserFlowPath = join(siteOutDir, "flows", "browser-flow.ts");
    writeFileSync(
      browserFlowPath,
      readFileSync(browserFlowPath, "utf8").replaceAll("@enricai/barnacle/", "@/")
    );

    const generatedModule = (await import(/* @vite-ignore */ contractPath)) as {
      plugin: SitePlugin<unknown, unknown>;
    };
    const { meta } = generatedModule.plugin;
    expect(typeof meta.browserFallbackGate).toBe("function");

    const mockHttpExecute = vi.fn();
    const mockExecute = vi.fn().mockResolvedValue({ data: { result: "browser-fallback" } });
    const generatedPlugin: SitePlugin<unknown, unknown> = {
      meta,
      executeHttp: mockHttpExecute,
      execute: mockExecute,
    };

    const context: SitePluginContext = {
      baseUrl: "https://example.com",
      logger: {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      } as unknown as SitePluginContext["logger"],
      config: {} as SitePluginContext["config"],
      requestId: "req-flow-declared-gate-timeout",
      metricsCollector: {
        startStep: vi.fn(),
        endStep: vi.fn(),
        markRetry: vi.fn(),
        finalize: vi.fn(() => ({
          totalDurationMs: 0,
          path: "http" as const,
          steps: [],
          attemptCount: 1,
          startedAt: "",
          endedAt: "",
          recordedAt: "",
        })),
      } as unknown as SitePluginContext["metricsCollector"],
      recordBeaconOutcome: vi.fn().mockResolvedValue(undefined),
      telemetry: new RunTelemetry(),
    };

    const { dispatch } = await import("@/plugins/loader.js");

    // Declared class (HttpSchemaError) is in the gate array — fallback IS
    // allowed, so dispatch routes to the browser plugin.execute().
    mockHttpExecute.mockRejectedValueOnce(new HttpSchemaError("schema mismatch"));
    const allowedResult = await dispatch(generatedPlugin, {}, context);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(allowedResult.data).toEqual({ result: "browser-fallback" });

    // A hot-path failure class NOT named in the declared array is blocked
    // from falling back — the original error rethrows and execute() is
    // never invoked.
    mockExecute.mockClear();
    mockHttpExecute.mockRejectedValueOnce(new HttpBotChallengeError("403 bot wall"));
    let caught: unknown;
    try {
      await dispatch(generatedPlugin, {}, context);
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toBe("403 bot wall");
    expect(mockExecute).not.toHaveBeenCalled();
  }, 30_000);
});
