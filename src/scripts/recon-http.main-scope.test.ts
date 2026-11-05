import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isOwnBackendTarget } from "@/scripts/recon-http";

const { logs } = vi.hoisted(() => ({ logs: [] as string[] }));
vi.mock("@/lib/logging", () => ({
  getScriptLogger: () => ({
    info: (m: string) => logs.push(m),
    warn: (m: string) => logs.push(m),
    error: (m: string) => logs.push(m),
    debug: () => {},
  }),
}));

describe("isOwnBackendTarget unparseable URL", () => {
  it("returns false", () => {
    expect(isOwnBackendTarget("not a url", [], null)).toBe(false);
  });
});

describe("recon-http main() own-backend filter wiring", () => {
  let dir: string;
  const origArgv = process.argv;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rh-main-"));
    logs.length = 0;
  });
  afterEach(() => {
    process.argv = origArgv;

    delete process.env.RECON_OUT_DIR;
    rmSync(dir, { recursive: true, force: true });
    vi.resetModules();
  });

  it("never replays loopback or foreign hosts, replays the own backend", async () => {
    const caps = join(dir, "caps");
    mkdirSync(caps);
    const mk = (url: string) => ({
      timestamp: "t",
      phase: "p",
      method: "GET",
      url,
      status: 200,
      requestHeaders: {},
      requestPostData: null,
      responseBody: {},
      operationName: null,
      query: null,
      variables: null,
    });
    writeFileSync(join(caps, "a.json"), JSON.stringify(mk("https://api.site.com/a")));
    writeFileSync(join(caps, "b.json"), JSON.stringify(mk("http://127.0.0.1/b")));
    writeFileSync(join(caps, "c.json"), JSON.stringify(mk("https://other.com/c")));
    const flow = join(dir, "flow.json");
    writeFileSync(flow, JSON.stringify({ ownBackendHostnames: ["api.site.com"] }));

    const fetched: string[] = [];
    let stop = false;
    globalThis.fetch = (async (input: unknown) => {
      fetched.push(String(input instanceof Request ? input.url : input));
      return new Response("{}", { status: stop ? 429 : 200 });
    }) as typeof fetch;

    process.env.RECON_OUT_DIR = join(dir, "out");
    process.argv = [
      "node",
      "recon-http.ts",
      "--captures-dir",
      caps,
      "--flow-file",
      flow,
      "--out-dir",
      join(dir, "out"),
    ];
    vi.resetModules();
    await import("@/scripts/recon-http");
    await vi.waitFor(
      () => expect(logs.some((l) => l.includes("rate-limit targets: 1"))).toBe(true),
      {
        timeout: 20000,
      }
    );

    expect(logs).toContain("skipped http://127.0.0.1/b: outside own-backend scope or loopback");
    expect(logs).toContain("skipped https://other.com/c: outside own-backend scope or loopback");
    expect(fetched.some((u) => u.includes("api.site.com"))).toBe(true);
    expect(
      fetched
        .filter((u) => !u.endsWith("/robots.txt"))
        .some((u) => u.includes("127.0.0.1") || u.includes("other.com/c"))
    ).toBe(false);
    stop = true;
  }, 30000);
});
