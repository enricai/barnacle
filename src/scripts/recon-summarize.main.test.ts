import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const origArgv = process.argv;

afterEach(() => {
  process.argv = origArgv;
  vi.resetModules();
});

const w = (dir: string, name: string, v: unknown) =>
  writeFileSync(join(dir, name), JSON.stringify(v));

const cap = (url: string, method: string, operationName: string | null) => ({
  timestamp: "2024-01-02T03:04:00.000Z",
  phase: "p",
  method,
  url,
  status: 200,
  requestHeaders: {},
  requestPostData: null,
  responseHeaders: {},
  responseBody: null,
  operationName,
  query: null,
  variables: null,
  decodedParams: null,
});

const replay = (url: string, replayStatus: number | null, success: boolean) => ({
  sourceCapture: "x",
  url,
  method: "POST",
  operationName: null,
  requestBody: null,
  replayStatus,
  replayHeaders: {},
  replayBody: null,
  success,
  error: null,
});

describe("recon-summarize main (real call path)", () => {
  it("renders every section from a run directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "recon-sum-"));
    for (const d of ["graphql", "replays", "aux"]) mkdirSync(join(root, d), { recursive: true });
    w(join(root, "graphql"), "a.json", cap("https://a.com/gql", "POST", "Op1"));
    w(join(root, "graphql"), "b.json", cap("https://a.com/rest", "GET", null));
    w(join(root, "graphql"), "c.json", cap("https://a.com/other", "GET", null));
    w(join(root, "replays"), "a.json", {
      ...replay("https://a.com/gql", 200, true),
      replayHeaders: { "x-custom": "1" },
    });
    w(join(root, "replays"), "b.json", replay("https://a.com/rest", null, false));
    w(join(root, "replays"), "c.json", replay("https://a.com/auth", 401, false));
    w(join(root, "replays"), "d.json", replay("https://a.com/blocked", 403, false));
    w(join(root, "replays"), "rate-limit.json", [
      {
        endpoint: "https://a.com/gql",
        safeRps: 4,
        triggerStatus: 429,
        triggerRps: 8,
        retryAfter: null,
        xRateLimitHeaders: { "x-akamai-x": "1" },
      },
      {
        endpoint: "https://a.com/rest",
        safeRps: null,
        triggerStatus: null,
        triggerRps: null,
        retryAfter: null,
        xRateLimitHeaders: {},
      },
      {
        endpoint: "https://cdn.other.com/z",
        safeRps: 1,
        triggerStatus: null,
        triggerRps: null,
        retryAfter: null,
        xRateLimitHeaders: {},
      },
    ]);
    w(join(root, "aux"), "fixture.json", {});
    const out = join(root, "out", "r.md");

    process.argv = [
      "node",
      "/x/recon-summarize.ts",
      "--site-id",
      "acme",
      "--out",
      out,
      "--run-dir",
      root,
    ];
    await import("@/scripts/recon-summarize.js");
    await vi.waitFor(() => expect(() => readFileSync(out, "utf8")).not.toThrow());
    const md = readFileSync(out, "utf8");

    expect(md).toContain("| Auth required | YES");
    expect(md).toContain("| Bot detection | YES");
    expect(md).toContain("| Auxiliary fixtures | 1 |");
    expect(md).toContain("operations: Op1");
    expect(md).toContain("— REST — replay: `ERR`");
    expect(md).toContain("replay: not replayed");
    expect(md).toContain("— public** (replayed 200)".replace("— ", "— **"));
    expect(md).toContain("— 401. Capture token");
    expect(md).toContain("triggered 429 at 8 rps");
    expect(md).toContain("minTime: 250");
    expect(md).toContain("**unknown** (no trigger observed)");
    expect(md).not.toContain("cdn.other.com");
    expect(md).toContain("- Akamai edge detected");
    expect(md).toContain("`fixture.json` — commit as `src/sites/acme/fixtures/fixture.json`");
    expect(md).toContain("Jan 2, 2024");
  });

  it("renders the Codified Headers table from shape-diverging replays", async () => {
    const root = mkdtempSync(join(tmpdir(), "recon-sum-"));
    for (const d of ["graphql", "replays"]) mkdirSync(join(root, d), { recursive: true });
    w(join(root, "graphql"), "a.json", cap("https://a.com/gql", "POST", "Op1"));
    w(join(root, "replays"), "a.json", {
      ...replay("https://a.com/gql", 200, true),
      shapeDiffers: true,
      omittedCaptureHeaders: ["Key-Inflection", "x-b", "x-c", "Authorization"],
      shapeRestoringHeaders: ["Key-Inflection", "x-b", "Authorization"],
    });
    w(join(root, "replays"), "b.json", {
      ...replay("https://a.com/gql2", 200, true),
      shapeDiffers: true,
      omittedCaptureHeaders: ["key-inflection"],
      shapeRestoringHeaders: ["key-inflection"],
    });
    const out = join(root, "out", "r.md");
    process.argv = [
      "node",
      "/x/recon-summarize.ts",
      "--site-id",
      "acme",
      "--out",
      out,
      "--run-dir",
      root,
    ];
    await import("@/scripts/recon-summarize.js");
    await vi.waitFor(() => expect(() => readFileSync(out, "utf8")).not.toThrow());
    const md = readFileSync(out, "utf8");
    expect(md).toContain("## Codified Headers (Step 4b)");
    expect(md).toContain("(of 2)");
    expect(md).toContain("| `key-inflection` | 2 | **Yes** |");
    expect(md).toContain("| `x-b` | 1 | **Yes** |");
    expect(md).toContain("| `authorization` | 1 | **Yes** (credential: obtain per call) |");
    expect(md).not.toContain("`x-c`");
    expect(md).not.toContain("_No request headers implicated");
  });
});
