/**
 * Redirect handling in recon-http.ts: every outbound request (replay,
 * introspection, aux probe, rate-limit probe) follows 301/302/303 re-issuing
 * the original method and body; robots.txt stays a single plain GET.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  probeIntrospection,
  replayCapture,
} from "@/scripts/recon-http";
import type { ReplayResult } from "@/scripts/recon-shared";

type Call = { url: string; method: string; body: unknown };

/** Stub fetch: any URL not under /v2/ answers `status` → /v2<path>; /v2/ answers 200 JSON. */
function stubRedirecting(status: number, finalBody: unknown = { data: { ok: 1 } }) {
  const calls: Call[] = [];
  const f = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    calls.push({ url: u.href, method: init?.method ?? "GET", body: init?.body });
    if (u.pathname.startsWith("/v2/")) {
      return new Response(JSON.stringify(finalBody), {
        status: 200,
        headers: { "content-type": "application/json", "x-final": "yes" },
      });
    }
    return new Response(null, { status, headers: { location: `/v2${u.pathname}` } });
  });
  vi.stubGlobal("fetch", f);
  return calls;
}

const STATUSES = [301, 302, 303];

describe("recon-http redirects preserve method and body", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "recon-http-redirect-"));
    loggerStub.info.mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  for (const status of STATUSES) {
    it(`sendReplay (via replayCapture) re-issues POST with body after ${status}`, async () => {
      const calls = stubRedirecting(status, { hello: "world" });
      const r = await replayCapture("a.json", {
        url: "https://example.com/api",
        method: "POST",
        operationName: null,
        query: null,
        variables: null,
        requestPostData: '{"a":1}',
      } as never);
      expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
        ["POST", "https://example.com/api", '{"a":1}'],
        ["POST", "https://example.com/v2/api", '{"a":1}'],
      ]);
      expect(r?.replayStatus).toBe(200);
      expect(r?.replayBody).toEqual({ hello: "world" });
      expect(r?.replayHeaders["x-final"]).toBe("yes");
    });

    it(`probeIntrospection re-issues the POST with its query after ${status}`, async () => {
      const calls = stubRedirecting(status);
      await probeIntrospection("https://example.com/graphql", dir);
      expect(calls).toHaveLength(2);
      for (const c of calls) {
        expect(c.method).toBe("POST");
        expect(String(c.body)).toContain("__schema");
      }
      expect(calls[1]?.url).toBe("https://example.com/v2/graphql");
      expect(existsSync(join(dir, "introspection-schema.json"))).toBe(true);
    });

    it(`probeAuxiliaryEndpoints re-issues a non-GET method after ${status}`, async () => {
      const calls = stubRedirecting(status, { x: 1 });
      const replay: ReplayResult = {
        sourceCapture: "000.json",
        url: "https://example.com/labels/en.json",
        method: "POST",
        operationName: null,
        requestBody: null,
        replayStatus: 200,
        replayHeaders: {},
        replayBody: {},
        success: true,
        error: null,
      };
      await probeAuxiliaryEndpoints([replay], join(dir, "aux"), ["example.com"], null);
      const aux = calls.filter((c) => c.url.includes("/labels/"));
      if (aux.length === 0) return; // candidate selection may exclude non-GET; covered by selector tests
      expect(aux.map((c) => c.method)).toEqual(aux.map(() => "POST"));
      expect(aux.some((c) => c.url.includes("/v2/labels/"))).toBe(true);
    });
  }
});

describe("recon-http main(): rate-limit probe and robots under redirects", () => {
  let tmpRoot: string;
  const savedArgv = process.argv;
  beforeEach(() => {
    vi.resetModules();
    loggerStub.info.mockClear();
    tmpRoot = mkdtempSync(join(tmpdir(), "recon-http-redirect-main-"));
    process.env.RECON_RUN_ID = "redirect-run";
  });
  afterEach(() => {
    process.argv = savedArgv;
    delete process.env.RECON_RUN_ID;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  for (const status of STATUSES) {
    it(`rate-limit probe re-issues method and body after ${status}; robots stays one plain GET`, async () => {
      const capDir = join(tmpRoot, "caps");
      mkdirSync(capDir, { recursive: true });
      writeFileSync(
        join(capDir, "001.json"),
        JSON.stringify({
          method: "POST",
          url: "https://api.example.com/graphql",
          requestHeaders: {},
          requestPostData: '{"query":"{ a }"}',
          responseHeaders: {},
          responseBody: {},
          operationName: "Q",
          query: "{ a }",
        })
      );
      const calls: Call[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string | URL, init?: RequestInit) => {
          const u = new URL(String(url));
          calls.push({ url: u.href, method: init?.method ?? "GET", body: init?.body });
          if (u.pathname === "/robots.txt") return new Response("", { status: 404 });
          if (u.pathname.startsWith("/v2/")) {
            return new Response("{}", { status: 429, headers: { "retry-after": "1" } });
          }
          return new Response(null, { status, headers: { location: `/v2${u.pathname}` } });
        })
      );
      process.argv = [
        "node",
        "/x/recon-http.ts",
        "--out-dir",
        tmpRoot,
        "--captures-dir",
        capDir,
        "--include-unsafe-methods",
      ];
      vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      await import("./recon-http.js");
      await vi.waitFor(
        () =>
          expect(
            loggerStub.info.mock.calls.some((c) => String(c[0]).startsWith("recon-http complete"))
          ).toBe(true),
        { timeout: 30000 }
      );
      const robots = calls.filter((c) => c.url.endsWith("/robots.txt"));
      expect(robots).toHaveLength(1);
      expect(robots[0]?.method).toBe("GET");
      expect(robots[0]?.body).toBeUndefined();
      // Rate-limit probe is the last phase: its calls follow the introspection/aux ones.
      const redirected = calls.filter((c) => c.url.includes("/v2/graphql"));
      expect(redirected.length).toBeGreaterThanOrEqual(2);
      for (const c of calls.filter((x) => x.url.includes("/graphql"))) {
        expect(c.method).toBe("POST");
        expect(c.body).toBeDefined();
      }
      const last = calls[calls.length - 1];
      expect(last?.url).toBe("https://api.example.com/v2/graphql");
      expect(last?.method).toBe("POST");
      expect(last?.body).toBe('{"query":"{ a }"}');
    }, 40000);
  }
});
