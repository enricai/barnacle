/**
 * Unit tests for recon-http.ts's testable seams: run-scoped output dir
 * resolution and the rate-limit probe target builder. No test binds a real
 * network socket — `main()` never runs (module-load guard on
 * `process.argv[1]`), and the target builder is a pure function over an
 * in-memory replay list.
 *
 * Note on the bug report's Finding 2 ("rate-limit probe ignores the noise
 * filter"): at HEAD the replay phase already excludes noise hosts before
 * `replays` is populated (recon-http.ts:445, `probeworthy = unique.filter(...
 * !isNoiseUrl(capture.url))`), so the report's end-to-end claim is partially
 * stale. The genuine residual gap — asserted below — was that
 * `selectRateLimitTargets` had no `isNoiseUrl` guard of its own, so a noise
 * URL that reached `replays` by some other path had nothing stopping it from
 * becoming a rate-limit target. That guard now exists; these tests pin it so
 * it cannot regress. Do not re-file the end-to-end claim.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("@/lib/http", () => ({ configureHttpDispatcher: vi.fn() }));

import {
  probeAuxiliaryEndpoints,
  selectAuxFixtureCandidates,
  selectRateLimitTargets,
} from "@/scripts/recon-http";
import type { ReplayResult } from "@/scripts/recon-shared";

function replay(overrides: Partial<ReplayResult>): ReplayResult {
  return {
    sourceCapture: "000-capture.json",
    url: "https://api.example.com/real/endpoint",
    method: "GET",
    operationName: null,
    requestBody: null,
    replayStatus: 200,
    replayHeaders: {},
    replayBody: {},
    success: true,
    error: null,
    ...overrides,
  };
}

describe("recon-http run-scoped output dirs", () => {
  let tmpRoot: string;
  const originalOutDir = process.env.RECON_OUT_DIR;
  const originalRunId = process.env.RECON_RUN_ID;

  beforeEach(() => {
    vi.resetModules();
    tmpRoot = mkdtempSync(join(tmpdir(), "recon-http-test-"));
    process.env.RECON_OUT_DIR = tmpRoot;
    process.env.RECON_RUN_ID = "fixed-run-id";
  });

  afterEach(() => {
    if (originalOutDir === undefined) delete process.env.RECON_OUT_DIR;
    else process.env.RECON_OUT_DIR = originalOutDir;
    if (originalRunId === undefined) delete process.env.RECON_RUN_ID;
    else process.env.RECON_RUN_ID = originalRunId;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("resolves captures/replays/aux dirs under one injected run root, not a /tmp/recon literal", async () => {
    const { resolveReconRunDir } = await import("@/scripts/recon-shared.js");
    const runDir = resolveReconRunDir();

    expect(runDir.root).toBe(join(tmpRoot, "fixed-run-id"));
    expect(runDir.graphqlDir).toBe(join(tmpRoot, "fixed-run-id", "graphql"));
    expect(runDir.replaysDir).toBe(join(tmpRoot, "fixed-run-id", "replays"));
    expect(runDir.auxDir).toBe(join(tmpRoot, "fixed-run-id", "aux"));
    // All three dirs share the same run root — none resolves independently.
    expect(runDir.graphqlDir.startsWith(runDir.root)).toBe(true);
    expect(runDir.replaysDir.startsWith(runDir.root)).toBe(true);
    expect(runDir.auxDir.startsWith(runDir.root)).toBe(true);
  });

  it("memoizes the run dir so repeated calls in one process share a root", async () => {
    const { resolveReconRunDir } = await import("@/scripts/recon-shared.js");
    const first = resolveReconRunDir();
    const second = resolveReconRunDir();
    expect(second.root).toBe(first.root);
  });
});

describe("selectRateLimitTargets — noise host exclusion", () => {
  const originalPatterns = process.env.RECON_TELEMETRY_URL_PATTERNS;

  beforeEach(() => {
    // bat.bing.com / tr.snapchat.com / sw88.go.com are not in isNoiseUrl's
    // built-in THIRD_PARTY_ASSET_HOSTS list (verified: isNoiseUrl returns
    // false for all three at HEAD) — RECON_TELEMETRY_URL_PATTERNS is the
    // documented, existing mechanism (README §out-of-tree env vars) for a
    // caller to add site-specific telemetry hosts, so this test uses it
    // rather than editing the shared noise list, which is out of this
    // subtask's scope.
    process.env.RECON_TELEMETRY_URL_PATTERNS = "bat.bing.com,tr.snapchat.com,sw88.go.com";
  });

  afterEach(() => {
    if (originalPatterns === undefined) delete process.env.RECON_TELEMETRY_URL_PATTERNS;
    else process.env.RECON_TELEMETRY_URL_PATTERNS = originalPatterns;
  });

  it("keeps only the real endpoint when noise hosts are mixed into the replay list", () => {
    const replays: ReplayResult[] = [
      replay({ url: "https://api.example.com/real/endpoint", sourceCapture: "000-real.json" }),
      replay({ url: "https://bat.bing.com/action/0", sourceCapture: "001-bing.json" }),
      replay({ url: "https://tr.snapchat.com/cm", sourceCapture: "002-snap.json" }),
      replay({
        url: "https://sw88.go.com/rd?g=beacon&pixel=1",
        sourceCapture: "003-adobe.json",
      }),
    ];

    const { targets } = selectRateLimitTargets(replays);

    expect(Array.from(targets.keys())).toEqual(["https://api.example.com/real/endpoint"]);
  });

  it("still drops static fixture endpoints (path-suffix check) alongside noise", () => {
    const replays: ReplayResult[] = [
      replay({ url: "https://api.example.com/real/endpoint" }),
      replay({ url: "https://api.example.com/config/markets.json" }),
      replay({ url: "https://bat.bing.com/action/0" }),
    ];

    const { targets } = selectRateLimitTargets(replays);

    expect(Array.from(targets.keys())).toEqual(["https://api.example.com/real/endpoint"]);
  });

  it("excludes failed replays regardless of noise status", () => {
    const replays: ReplayResult[] = [
      replay({ url: "https://api.example.com/real/endpoint", success: false, replayStatus: 500 }),
    ];

    const { targets } = selectRateLimitTargets(replays);

    expect(targets.size).toBe(0);
  });
});

describe("selectAuxFixtureCandidates — own-backend host allowlist", () => {
  it("excludes a fictitious third-party vendor host even though it is path-shaped like a fixture", () => {
    const replays: ReplayResult[] = [
      replay({ url: "https://api.example.com/config/markets.json" }),
      replay({ url: "https://widgets.some-survey-vendor.example/formDataV2_123_en.json" }),
    ];

    const candidates = selectAuxFixtureCandidates(replays, ["api.example.com"], null);

    expect(candidates.map((c) => c.url)).toEqual(["https://api.example.com/config/markets.json"]);
  });

  it("keeps a subdomain declared in ownBackendHostnames and a bare .json path", () => {
    const replays: ReplayResult[] = [
      replay({ url: "https://api.example.com/dictionary.json" }),
      replay({ url: "https://www.example.com/labels/en.json" }),
    ];

    const candidates = selectAuxFixtureCandidates(
      replays,
      ["api.example.com", "www.example.com"],
      null
    );

    expect(candidates.map((c) => c.url).sort()).toEqual([
      "https://api.example.com/dictionary.json",
      "https://www.example.com/labels/en.json",
    ]);
  });

  it("falls back to the registrable domain of fallbackHost when ownBackendHostnames is unset", () => {
    const replays: ReplayResult[] = [
      replay({ url: "https://static.example.com/currencies.json" }),
      replay({ url: "https://widgets.some-survey-vendor.example/config.json" }),
    ];

    const candidates = selectAuxFixtureCandidates(replays, [], "api.example.com");

    expect(candidates.map((c) => c.url)).toEqual(["https://static.example.com/currencies.json"]);
  });

  it("harvests nothing when ownBackendHostnames is unset and there is no fallback host", () => {
    const replays: ReplayResult[] = [
      replay({ url: "https://api.example.com/config/markets.json" }),
    ];

    const candidates = selectAuxFixtureCandidates(replays, [], null);

    expect(candidates).toEqual([]);
  });

  it("still excludes isNoiseUrl hosts even when they would otherwise match the allowlist", () => {
    const replays: ReplayResult[] = [
      replay({ url: "https://cdn.cookielaw.org/consent/config.json" }),
    ];

    const candidates = selectAuxFixtureCandidates(replays, ["cdn.cookielaw.org"], null);

    expect(candidates).toEqual([]);
  });

  it("keeps only the own-backend candidate when several distinct third-party hosts are mixed in", () => {
    const replays: ReplayResult[] = [
      replay({ url: "https://api.example.com/config/markets.json" }),
      replay({ url: "https://widgets.some-survey-vendor.example/config.json" }),
      replay({ url: "https://cdn.some-analytics-vendor.example/pixel/config.json" }),
      replay({ url: "https://tag.some-tagmanager-vendor.example/labels/en.json" }),
    ];

    const candidates = selectAuxFixtureCandidates(replays, ["api.example.com"], null);

    expect(candidates.map((c) => c.url)).toEqual(["https://api.example.com/config/markets.json"]);
  });

  it("excludes non-fixture-shaped paths and failed/GraphQL replays", () => {
    const replays: ReplayResult[] = [
      replay({ url: "https://api.example.com/order/checkout" }),
      replay({ url: "https://api.example.com/config/markets.json", success: false }),
      replay({
        url: "https://api.example.com/config/markets.json",
        operationName: "GetMarkets",
      }),
    ];

    const candidates = selectAuxFixtureCandidates(replays, ["api.example.com"], null);

    expect(candidates).toEqual([]);
  });
});

describe("probeAuxiliaryEndpoints — aux-manifest.json host provenance", () => {
  let auxDir: string;
  const originalFetch = global.fetch;

  beforeEach(() => {
    auxDir = mkdtempSync(join(tmpdir(), "recon-http-aux-test-"));
  });

  afterEach(() => {
    global.fetch = originalFetch;
    rmSync(auxDir, { recursive: true, force: true });
  });

  it("records one manifest entry per written fixture, with the correct hostname", async () => {
    global.fetch = vi.fn(async (url: string | URL) => {
      return new Response(JSON.stringify({ from: url.toString() }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const replays: ReplayResult[] = [
      replay({ url: "https://api.example.com/config/markets.json" }),
      replay({ url: "https://www.example.com/labels/en.json" }),
    ];

    await probeAuxiliaryEndpoints(replays, auxDir, ["api.example.com", "www.example.com"], null);

    const manifest = JSON.parse(readFileSync(join(auxDir, "aux-manifest.json"), "utf-8"));

    expect(manifest).toHaveLength(2);
    expect(manifest).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          filename: "markets.json",
          url: "https://api.example.com/config/markets.json",
          hostname: "api.example.com",
        }),
        expect.objectContaining({
          filename: "en.json",
          url: "https://www.example.com/labels/en.json",
          hostname: "www.example.com",
        }),
      ])
    );
  });

  it("writes no manifest when there are no candidates to write", async () => {
    global.fetch = vi.fn() as unknown as typeof fetch;

    const replays: ReplayResult[] = [replay({ url: "https://api.example.com/order/checkout" })];

    await probeAuxiliaryEndpoints(replays, auxDir, ["api.example.com"], null);

    expect(existsSync(join(auxDir, "aux-manifest.json"))).toBe(false);
  });
});
