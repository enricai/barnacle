/**
 * Cross-module regression test for the recon run-dir resolver
 * (`resolveReconRunDir`, `@/scripts/recon-shared`). Proves the bug's actual
 * invariant — complete disjointness between two runs' output trees — rather
 * than a single module's symptom. Drives writes through TWO real recon
 * modules sharing the one resolver: `recon-browser.ts`'s
 * `snapshotAndPersistCookieJar` (the browser writer) and the same
 * resolver + `writeFileSync` pattern `recon-http.ts` uses inline in
 * `main()` for replay results (recon-http has no exported per-file writer,
 * so this test exercises the identical write path instead of faking it).
 *
 * Uses an injected `mkdtempSync` root + `RECON_OUT_DIR`/`RECON_RUN_ID` so no
 * write ever lands under the real `/tmp/recon` — reproducing the bug this
 * test guards against would defeat its own purpose.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StepVerificationErrorKind } from "@/scraper/errors";

vi.mock("@/config", () => ({
  config: {
    scraper: {
      useBedrock: false,
      anthropicApiKey: "test-key",
      model: "anthropic/claude-sonnet-4-6",
      proxyType: "residential",
      steelSessionTimeoutMs: 30000,
    },
    telemetry: {
      callsNdjsonPath: ".barnacle/calls.ndjson",
    },
  },
}));
vi.mock("@/lib/http", () => ({ configureHttpDispatcher: vi.fn() }));
vi.mock("@/scraper/session", () => ({ createBrowserSession: vi.fn() }));
vi.mock("@/scraper/errors", () => ({
  StepVerificationError: class StepVerificationError extends Error {
    readonly kind: StepVerificationErrorKind;
    constructor(message = "step failed", kind: StepVerificationErrorKind = "cascade-exhausted") {
      super(message);
      this.kind = kind;
    }
  },
}));

const { loggerStub } = vi.hoisted(() => ({
  loggerStub: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    errorWithStack: vi.fn(),
  },
}));
vi.mock("@/lib/logging", () => ({
  getLogger: () => loggerStub,
  getScriptLogger: () => loggerStub,
}));

vi.mock("@/lib/telemetry/call-capture", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/telemetry/call-capture")>();
  return {
    ...actual,
    captureLlmCall: vi.fn().mockResolvedValue(undefined),
  };
});

interface RunContext {
  runId: string;
  root: string;
  replaysDir: string;
  cookiesDir: string;
  snapshotAndPersistCookieJar: (
    page: { sendCDP: (...args: unknown[]) => Promise<{ cookies: unknown[] }> },
    counter: { n: number },
    label: string,
    phase: string,
    stepIndex: number
  ) => Promise<void>;
}

function makeCookiePage(runTag: string): { sendCDP: ReturnType<typeof vi.fn> } {
  return {
    sendCDP: vi.fn().mockResolvedValue({
      cookies: [{ name: "run", value: runTag, domain: ".example.com", path: "/", httpOnly: false }],
    }),
  };
}

describe("recon run-dir resolver — cross-run isolation (recon-browser + recon-http)", () => {
  let outRoot: string;

  // `resolveReconRunDir` memoizes per process, so each run context must pin
  // its own RECON_RUN_ID/RECON_OUT_DIR and `vi.resetModules()` before import
  // — the same seam recon-browser.test.ts and recon-http.test.ts establish
  // individually. Reused here to hold two run contexts live at once.
  async function buildRunContext(runId: string): Promise<RunContext> {
    process.env.RECON_RUN_ID = runId;
    process.env.RECON_OUT_DIR = outRoot;
    vi.resetModules();

    const { resolveReconRunDir } = await import("@/scripts/recon-shared.js");
    const { snapshotAndPersistCookieJar } = await import("@/scripts/recon-browser.js");
    const runDir = resolveReconRunDir();

    return {
      runId,
      root: runDir.root,
      replaysDir: runDir.replaysDir,
      cookiesDir: runDir.cookiesDir,
      snapshotAndPersistCookieJar,
    };
  }

  /** Mirrors recon-http.ts:452's inline replay writer — same resolver, same write pattern. */
  function writeHttpReplay(ctx: RunContext, filename: string, body: unknown): void {
    writeFileSync(join(ctx.replaysDir, filename), JSON.stringify(body, null, 2));
  }

  beforeEach(() => {
    outRoot = mkdtempSync(join(tmpdir(), "recon-run-isolation-"));
  });

  afterEach(() => {
    rmSync(outRoot, { recursive: true, force: true });
    delete process.env.RECON_RUN_ID;
    delete process.env.RECON_OUT_DIR;
    vi.restoreAllMocks();
  });

  function listFilesRecursive(root: string): string[] {
    return readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
      .sort();
  }

  it("two run contexts writing identical logical filenames from both the browser and http writers stay fully disjoint", async () => {
    const runA = await buildRunContext("20260718-100000-runa");
    const pageA = makeCookiePage("A");
    await runA.snapshotAndPersistCookieJar(pageA as never, { n: 0 }, "goto", "home", 0);
    writeHttpReplay(runA, "000-replay.json", { sourceCapture: "000-capture.json", run: "A" });

    const runB = await buildRunContext("20260718-100000-runb");
    const pageB = makeCookiePage("B");
    await runB.snapshotAndPersistCookieJar(pageB as never, { n: 0 }, "goto", "home", 0);
    writeHttpReplay(runB, "000-replay.json", { sourceCapture: "000-capture.json", run: "B" });

    // Same logical filenames from each writer in each run.
    expect(readdirSync(runA.cookiesDir)).toContain("000-goto-home.json");
    expect(readdirSync(runB.cookiesDir)).toContain("000-goto-home.json");
    expect(readdirSync(runA.replaysDir)).toContain("000-replay.json");
    expect(readdirSync(runB.replaysDir)).toContain("000-replay.json");

    // Property under test: complete disjointness by absolute path.
    const filesA = listFilesRecursive(runA.root);
    const filesB = listFilesRecursive(runB.root);
    expect(filesA.length).toBeGreaterThan(0);
    expect(filesB.length).toBeGreaterThan(0);
    const intersection = filesA.filter((path) => filesB.includes(path));
    expect(intersection).toEqual([]);
    expect(new Set([...filesA, ...filesB]).size).toBe(filesA.length + filesB.length);

    // Each file's content matches its own run, not the other's.
    const cookieBodyA = JSON.parse(
      readFileSync(join(runA.cookiesDir, "000-goto-home.json"), "utf8")
    );
    const cookieBodyB = JSON.parse(
      readFileSync(join(runB.cookiesDir, "000-goto-home.json"), "utf8")
    );
    expect(cookieBodyA.cookies).toEqual([expect.objectContaining({ name: "run", value: "A" })]);
    expect(cookieBodyB.cookies).toEqual([expect.objectContaining({ name: "run", value: "B" })]);

    const replayBodyA = JSON.parse(readFileSync(join(runA.replaysDir, "000-replay.json"), "utf8"));
    const replayBodyB = JSON.parse(readFileSync(join(runB.replaysDir, "000-replay.json"), "utf8"));
    expect(replayBodyA.run).toBe("A");
    expect(replayBodyB.run).toBe("B");

    // The parent temp root holds exactly the two run dirs — no orphaned or
    // shared-namespace directories.
    const runDirs = readdirSync(outRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
    expect(runDirs.map((e) => e.name).sort()).toEqual(
      [runA.runId, runB.runId].sort((a, b) => a.localeCompare(b))
    );
    expect(runDirs).toHaveLength(2);
  });
});
