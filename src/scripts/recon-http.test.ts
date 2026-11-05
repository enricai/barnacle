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
  parseMethodsFilter,
  probeAuxiliaryEndpoints,
  replayCapture,
  selectAuxFixtureCandidates,
  selectRateLimitTargets,
  selectReplayCaptures,
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
      replay({
        url: "https://api.example.com/real/endpoint",
        sourceCapture: "000-real.json",
      }),
      replay({
        url: "https://bat.bing.com/action/0",
        sourceCapture: "001-bing.json",
      }),
      replay({
        url: "https://tr.snapchat.com/cm",
        sourceCapture: "002-snap.json",
      }),
      replay({
        url: "https://sw88.go.com/rd?g=beacon&pixel=1",
        sourceCapture: "003-adobe.json",
      }),
    ];

    const { targets } = selectRateLimitTargets(replays, [], "example.com");

    expect(Array.from(targets.keys())).toEqual(["https://api.example.com/real/endpoint"]);
  });

  it("still drops static fixture endpoints (path-suffix check) alongside noise", () => {
    const replays: ReplayResult[] = [
      replay({ url: "https://api.example.com/real/endpoint" }),
      replay({ url: "https://api.example.com/config/markets.json" }),
      replay({ url: "https://bat.bing.com/action/0" }),
    ];

    const { targets } = selectRateLimitTargets(replays, [], "example.com");

    expect(Array.from(targets.keys())).toEqual(["https://api.example.com/real/endpoint"]);
  });

  it("excludes failed replays regardless of noise status", () => {
    const replays: ReplayResult[] = [
      replay({
        url: "https://api.example.com/real/endpoint",
        success: false,
        replayStatus: 500,
      }),
    ];

    const { targets } = selectRateLimitTargets(replays, [], "example.com");

    expect(targets.size).toBe(0);
  });
});

describe("selectRateLimitTargets — captured query string", () => {
  it("probes the captured request including its query string, not the bare path", () => {
    const { targets } = selectRateLimitTargets([
      replay({ url: "https://api.example.com/items?id=42&lang=en" }),
    ], [], "example.com");

    expect(Array.from(targets.keys())).toEqual(["https://api.example.com/items?id=42&lang=en"]);
  });

  it("keeps the query for a path ending in .json and probes each endpoint once", () => {
    const { targets } = selectRateLimitTargets([
      replay({ url: "https://api.example.com/v1/search.json?q=a" }),
      replay({ url: "https://api.example.com/v1/search.json?q=b" }),
    ], [], "example.com");

    expect(Array.from(targets.keys())).toEqual(["https://api.example.com/v1/search.json?q=a"]);
  });
});

describe("selectAuxFixtureCandidates — own-backend host allowlist", () => {
  it("excludes a fictitious third-party vendor host even though it is path-shaped like a fixture", () => {
    const replays: ReplayResult[] = [
      replay({ url: "https://api.example.com/config/markets.json" }),
      replay({
        url: "https://widgets.some-survey-vendor.example/formDataV2_123_en.json",
      }),
    ];

    const candidates = selectAuxFixtureCandidates(replays, ["api.example.com"], null);

    expect(candidates.map((c) => c.url)).toEqual(["https://api.example.com/config/markets.json"]);
  });

  it("excludes a locale-dictionary-shaped path on a declared subdomain, but keeps a real reference-data path", () => {
    const replays: ReplayResult[] = [
      replay({
        url: "https://api.example.com/pulse/api/v1/locales/en/dictionary",
      }),
      replay({ url: "https://www.example.com/labels/en.json" }),
    ];

    const candidates = selectAuxFixtureCandidates(
      replays,
      ["api.example.com", "www.example.com"],
      null
    );

    expect(candidates.map((c) => c.url)).toEqual(["https://www.example.com/labels/en.json"]);
  });

  it("excludes a feature-flag-resolver-shaped path even though it ends in .json", () => {
    const replays: ReplayResult[] = [
      replay({
        url: "https://api.example.com/bin/services/core/flags/resolve.json",
      }),
    ];

    const candidates = selectAuxFixtureCandidates(replays, ["api.example.com"], null);

    expect(candidates).toEqual([]);
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
      replay({
        url: "https://cdn.some-analytics-vendor.example/pixel/config.json",
      }),
      replay({
        url: "https://tag.some-tagmanager-vendor.example/labels/en.json",
      }),
    ];

    const candidates = selectAuxFixtureCandidates(replays, ["api.example.com"], null);

    expect(candidates.map((c) => c.url)).toEqual(["https://api.example.com/config/markets.json"]);
  });

  it("excludes non-fixture-shaped paths and failed/GraphQL replays", () => {
    const replays: ReplayResult[] = [
      replay({ url: "https://api.example.com/order/checkout" }),
      replay({
        url: "https://api.example.com/config/markets.json",
        success: false,
      }),
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

describe("selectReplayCaptures", () => {
  const mk = (url: string, method: string) => ({
    filename: `${method}-${url}`,
    capture: { url, method } as never,
  });
  it("skips unsafe methods with reason, unless opted in; never selects data:", async () => {
    const { selectReplayCaptures } = await import("./recon-http.js");
    const caps = [
      mk("https://example.com/api/a", "GET"),
      mk("https://example.com/api/b", "POST"),
      mk("data:text/plain,hi", "GET"),
    ];
    const r = selectReplayCaptures(caps, false);
    expect(r.selected).toHaveLength(1);
    expect(r.skipped.map((s) => s.reason).some((x) => x.includes("POST"))).toBe(true);
    expect(r.skipped.some((s) => s.url.startsWith("data:"))).toBe(true);
    const r2 = selectReplayCaptures(caps, true);
    expect(r2.selected).toHaveLength(2);
  });
});

describe("recon-http main() end to end", () => {
  let tmpRoot: string;
  const saved = {
    argv: process.argv,
    out: process.env.RECON_OUT_DIR,
    run: process.env.RECON_RUN_ID,
  };

  beforeEach(() => {
    vi.resetModules();
    loggerStub.info.mockClear();
    tmpRoot = mkdtempSync(join(tmpdir(), "recon-http-main-"));
    process.env.RECON_RUN_ID = "main-run";
  });
  afterEach(() => {
    process.argv = saved.argv;
    if (saved.out === undefined) delete process.env.RECON_OUT_DIR;
    else process.env.RECON_OUT_DIR = saved.out;
    if (saved.run === undefined) delete process.env.RECON_RUN_ID;
    else process.env.RECON_RUN_ID = saved.run;
    vi.unstubAllGlobals();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  async function runMain(extra: string[]): Promise<string[]> {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const capDir = join(tmpRoot, "caps");
    mkdirSync(capDir, { recursive: true });
    const base = {
      timestamp: "t",
      phase: "p",
      status: 200,
      requestHeaders: {},
      requestPostData: null,
      responseHeaders: {},
      responseBody: {},
      operationName: null,
      query: null,
      variables: null,
      decodedParams: null,
    };
    writeFileSync(
      join(capDir, "001.json"),
      JSON.stringify({
        ...base,
        method: "GET",
        url: "https://api.example.com/a",
      })
    );
    writeFileSync(
      join(capDir, "002.json"),
      JSON.stringify({
        ...base,
        method: "POST",
        url: "https://api.example.com/b",
        requestPostData: "{}",
      })
    );
    const fetched: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string }) => {
        fetched.push(`${init?.method ?? "GET"} ${url}`);
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      })
    );
    process.argv = [
      "node",
      "/x/recon-http.ts",
      "--out-dir",
      tmpRoot,
      "--captures-dir",
      capDir,
      ...extra,
    ];
    // Collapse the rate-limit probe's pacing delay so main() finishes fast.
    const realSetTimeout = globalThis.setTimeout;
    vi.stubGlobal("setTimeout", (fn: () => void, ms?: number) =>
      realSetTimeout(fn, ms && ms > 50 ? 0 : ms)
    );
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    await import("./recon-http.js");
    await vi.waitFor(
      () =>
        expect(
          loggerStub.info.mock.calls.some((c) => String(c[0]).startsWith("recon-http complete"))
        ).toBe(true),
      { timeout: 60000 }
    );
    return fetched;
  }

  it("skips unsafe-method captures by default and logs the rule", async () => {
    await runMain([]);
    const logs = loggerStub.info.mock.calls.map((c) => String(c[0]));
    expect(logs.some((l) => /1 skipped/.test(l))).toBe(true);
    expect(logs.some((l) => l.startsWith("skipped https://api.example.com/b"))).toBe(true);
    expect(existsSync(join(tmpRoot, "main-run", "replays", "001.json"))).toBe(true);
    expect(existsSync(join(tmpRoot, "main-run", "replays", "002.json"))).toBe(false);
  }, 70000);

  it("replays unsafe-method captures with --include-unsafe-methods", async () => {
    await runMain(["--include-unsafe-methods"]);
    const logs = loggerStub.info.mock.calls.map((c) => String(c[0]));
    expect(logs.some((l) => /skipped/.test(l) && /\(\d+ skipped\)/.test(l))).toBe(false);
    expect(existsSync(join(tmpRoot, "main-run", "replays", "002.json"))).toBe(true);
  }, 70000);
});

describe("selectRateLimitTargets — fixture shape and safety", () => {
  it("probes real .json endpoints, skips fixtures and unsafe methods", () => {
    const { targets } = selectRateLimitTargets([
      replay({ url: "https://api.example.com/x/schedule.json" }),
      replay({ url: "https://api.example.com/markets.json" }),
      replay({ url: "https://api.example.com/config/app" }),
      replay({ url: "https://api.example.com/locales/en" }),
      replay({ url: "https://api.example.com/submit", method: "POST" }),
    ], [], "example.com");
    expect(Array.from(targets.keys())).toEqual(["https://api.example.com/x/schedule.json"]);
  });
});

describe("replayCapture — marker and methods filter", () => {
  const base = {
    url: "https://example.com/api",
    operationName: null,
    query: null,
    variables: null,
  } as never;
  const mk = (method: string, requestPostData: string | null) =>
    ({ ...(base as object), method, requestPostData }) as never;

  afterEach(() => vi.unstubAllGlobals());

  it("skips marker captures without fetching, sends real bodies unchanged", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", f);
    expect(await replayCapture("a.json", mk("POST", "<unavailable>"))).toBeNull();
    expect(f).not.toHaveBeenCalled();
    const r = await replayCapture("b.json", mk("POST", "x=1"));
    expect(r?.requestBody).toBe("x=1");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("methods filter skips non-listed methods", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", f);
    const methods = parseMethodsFilter("get, head");
    expect(await replayCapture("a.json", mk("PUT", "x"), { methods })).toBeNull();
    expect(await replayCapture("b.json", mk("POST", null), { methods })).toBeNull();
    expect(f).not.toHaveBeenCalled();
    expect(await replayCapture("c.json", mk("GET", null), { methods })).not.toBeNull();
  });
});

describe("recon-http main() --methods and unavailable-body skipping", () => {
  it("runs end to end, skipping marker captures and method-filtered captures without fetching", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { REQUEST_BODY_UNAVAILABLE } = await import("@/scraper/request-body-marker.js");
    vi.resetModules();
    const root = mkdtempSync(join(tmpdir(), "recon-http-main-"));
    const caps = join(root, "caps");
    mkdirSync(caps);
    const base = {
      query: null,
      operationName: null,
      variables: null,
      decodedParams: null,
    };
    writeFileSync(
      join(caps, "001.json"),
      JSON.stringify({
        ...base,
        url: "https://api.example.com/a",
        method: "POST",
        requestPostData: REQUEST_BODY_UNAVAILABLE,
      })
    );
    writeFileSync(
      join(caps, "002.json"),
      JSON.stringify({
        ...base,
        url: "https://api.example.com/b",
        method: "GET",
        requestPostData: null,
      })
    );
    const fetchSpy = vi.fn(async (_url: string | URL) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const savedArgv = process.argv;
    const savedOut = process.env.RECON_OUT_DIR;
    process.env.RECON_OUT_DIR = root;
    process.argv = ["node", "recon-http.ts", "--captures-dir", caps, "--methods", "PUT"];
    try {
      await import("@/scripts/recon-http.js");
      await vi.waitFor(() =>
        expect(loggerStub.info).toHaveBeenCalledWith(expect.stringContaining("recon-http complete"))
      );
      // main() fetches /robots.txt per origin before per-capture filtering, so a
      // blanket "never fetched" assertion would fail on that politeness request.
      expect(
        fetchSpy.mock.calls.filter(([url]) => !String(url).endsWith("/robots.txt"))
      ).toHaveLength(0);
      expect(loggerStub.warn).toHaveBeenCalledWith(
        expect.stringContaining("request body unavailable")
      );
      expect(loggerStub.info).toHaveBeenCalledWith(
        expect.stringContaining("not in --methods filter")
      );
    } finally {
      process.argv = savedArgv;
      if (savedOut === undefined) delete process.env.RECON_OUT_DIR;
      else process.env.RECON_OUT_DIR = savedOut;
      vi.unstubAllGlobals();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("recon-http main() --methods opt-in wiring", () => {
  it("replays PUT (opted in) but not POST (not opted in) through main()", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    vi.resetModules();
    const root = mkdtempSync(join(tmpdir(), "recon-http-optin-"));
    const caps = join(root, "caps");
    mkdirSync(caps);
    const base = {
      query: null,
      operationName: null,
      variables: null,
      decodedParams: null,
    };
    writeFileSync(
      join(caps, "001.json"),
      JSON.stringify({
        ...base,
        url: "https://api.example.com/put",
        method: "PUT",
        requestPostData: "{}",
      })
    );
    writeFileSync(
      join(caps, "002.json"),
      JSON.stringify({
        ...base,
        url: "https://api.example.com/post",
        method: "POST",
        requestPostData: "{}",
      })
    );
    const fetchSpy = vi.fn(
      async (_url: string | URL, _init?: RequestInit) => new Response("{}", { status: 200 })
    );
    vi.stubGlobal("fetch", fetchSpy);
    const savedArgv = process.argv;
    const savedOut = process.env.RECON_OUT_DIR;
    process.env.RECON_OUT_DIR = root;
    process.argv = ["node", "recon-http.ts", "--captures-dir", caps, "--methods", "PUT"];
    try {
      await import("@/scripts/recon-http.js");
      await vi.waitFor(() =>
        expect(loggerStub.info).toHaveBeenCalledWith(expect.stringContaining("recon-http complete"))
      );
      const urls = fetchSpy.mock.calls.map(([u]) => String(u));
      expect(urls).toContain("https://api.example.com/put");
      expect(urls).not.toContain("https://api.example.com/post");
    } finally {
      process.argv = savedArgv;
      if (savedOut === undefined) delete process.env.RECON_OUT_DIR;
      else process.env.RECON_OUT_DIR = savedOut;
      vi.unstubAllGlobals();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("selectReplayCaptures — safe-by-default with --methods opt-in", () => {
  const mk = (method: string) => ({
    filename: `${method}.json`,
    capture: {
      method,
      url: "https://example.com/api",
      query: null,
      operationName: null,
    } as never,
  });
  const items = [mk("GET"), mk("POST"), mk("PUT")];

  it("skips and reports POST/PUT by default", () => {
    const r = selectReplayCaptures(items, false);
    expect(r.selected.map((i) => i.filename)).toEqual(["GET.json"]);
    expect(r.skipped.map((s) => s.filename)).toEqual(["POST.json", "PUT.json"]);
  });

  it("--methods PUT,POST opts those methods in", () => {
    const r = selectReplayCaptures(items, false, parseMethodsFilter("PUT,POST"));
    expect(r.selected.map((i) => i.filename)).toEqual(["GET.json", "POST.json", "PUT.json"]);
  });

  it("--methods PUT opts in only PUT", () => {
    const r = selectReplayCaptures(items, false, parseMethodsFilter("PUT"));
    expect(r.selected.map((i) => i.filename)).toEqual(["GET.json", "PUT.json"]);
  });
});
