import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { isZeroVarianceRepeatCapture } from "@/recon/capture-filters";
import { main } from "@/scripts/recon-generate";
import { RECON_GENERATE_CWD } from "@/scripts/recon-generate-cwd.test-helper";
import type { Capture } from "@/scripts/recon-shared";

const REPO_ROOT = join(__dirname, "..", "..");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

function cap(o: Partial<Capture>): Capture {
  return {
    timestamp: "2024-01-01T00:00:00Z",
    phase: "action",
    method: "POST",
    url: "https://api.example.com/v1/catalog/query",
    status: 200,
    requestHeaders: { "content-type": "application/json" },
    requestPostData: null,
    responseHeaders: { "content-type": "application/json" },
    responseBody: null,
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
    ...o,
  };
}

let workDir: string | null = null;
let siteOutDir: string | null = null;
afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate: declared read-only POST search", () => {
  it("is a read flow: no applicant/tracking/multipart, and the POST is emitted", async () => {
    workDir = mkdtempSync(join(tmpdir(), "declared-post-search-"));
    const runRoot = join(workDir, "run");
    mkdirSync(join(runRoot, "graphql"), { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), "[]");
    const caps: Capture[] = [];
    let t = 0;
    const ts = () => `2024-01-01T00:00:${String(10 + t++).padStart(2, "0")}Z`;
    for (const f of ["red", "blue", "green", "gold"]) {
      caps.push(cap({ method: "OPTIONS", timestamp: ts(), status: 204 }));
      caps.push(
        cap({
          timestamp: ts(),
          requestPostData: JSON.stringify({ filter: { color: f }, page: 1 }),
          responseBody: { items: [{ sku: `${f}-1`, name: `${f} thing` }] },
        })
      );
      caps.push(
        cap({
          url: "https://api.example.com/telemetry/collect",
          timestamp: ts(),
          requestPostData: JSON.stringify({ ev: "view", n: t }),
          responseBody: { ok: true },
        })
      );
    }
    for (const [i, c] of caps.entries()) {
      writeFileSync(
        join(runRoot, "graphql", `${String(i).padStart(3, "0")}-capture.json`),
        JSON.stringify(c)
      );
    }
    const siteId = `declared-post-search-read-e2e-${process.pid}`;
    siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        submitEndpointPattern: "/v1/catalog/query",
        steps: [{ step: "open catalog" }, { step: "apply filters and search" }],
      })
    );
    const savedArgv = process.argv;
    const savedCwd = process.cwd();
    const spies = (["log", "info", "warn", "error"] as const).map((k) =>
      vi.spyOn(console, k).mockImplementation(() => {})
    );
    const writes = [process.stdout, process.stderr].map((st) =>
      vi.spyOn(st, "write").mockImplementation((() => true) as never)
    );
    try {
      process.chdir(RECON_GENERATE_CWD);
      process.argv = [
        "node",
        GENERATE_SCRIPT,
        "--site-id",
        siteId,
        "--run-dir",
        runRoot,
        "--emit",
        "ts",
        "--force",
      ];
      await main();
    } finally {
      process.argv = savedArgv;
      process.chdir(savedCwd);
      for (const sp of [...spies, ...writes]) sp.mockRestore();
    }
    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contract).not.toContain("ApplicantContactSchema");
    expect(contract).not.toContain("JobTrackingSchema");
    expect(contract).not.toMatch(/multipart/i);
    expect(contract).toContain("/v1/catalog/query");
  }, 60_000);
  it("14 faceted searches (one filter array changes per step) bind the declared fields, are not noise, and are not a submission", async () => {
    workDir = mkdtempSync(join(tmpdir(), "declared-post-facets-"));
    const runRoot = join(workDir, "run");
    for (const d of ["graphql", "replays", "aux"]) mkdirSync(join(runRoot, d), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), "[]");
    const N = 14;
    const slug = (x: string) =>
      x
        .replace(/[^a-z0-9]+/gi, "-")
        .toLowerCase()
        .slice(0, 24);
    const stepName = (i: number) =>
      `Pick the ${["alpha", "beta", "gamma", "delta", "omega", "sigma", "theta", "kappa", "lambda", "zeta", "iota", "rho", "tau", "phi"][i]} widget group`;
    const caps: Capture[] = [];
    let t = 0;
    const ts = () =>
      `2024-01-01T00:${String(10 + Math.floor(t / 60)).padStart(2, "0")}:${String(t++ % 60).padStart(2, "0")}Z`;
    const filters: Record<string, string[]> = {};
    caps.push(
      cap({
        timestamp: ts(),
        phase: "open-catalog",
        requestPostData: JSON.stringify({ filters: {}, size: 10 }),
        responseBody: { items: [{ sku: "s-open" }] },
      })
    );
    for (let i = 0; i < N; i++) {
      filters[`group${i}`] = [`v${i}`];
      const phase = slug(stepName(i));
      caps.push(cap({ method: "OPTIONS", timestamp: ts(), status: 204, phase }));
      caps.push(
        cap({
          timestamp: ts(),
          phase,
          requestPostData: JSON.stringify({ filters: { ...filters }, size: 10 }),
          responseBody: { items: [{ sku: `s${i}`, name: `thing ${i}` }] },
        })
      );
      caps.push(
        cap({
          url: "https://api.example.com/telemetry/collect",
          timestamp: ts(),
          phase,
          requestPostData: JSON.stringify({ ev: "view", n: i }),
          responseBody: { ok: true },
        })
      );
    }
    const searches = caps.filter((c) => c.url.endsWith("/v1/catalog/query") && c.method === "POST");
    expect(searches).toHaveLength(N + 1);
    const isDeclared = (c: { url: string }) => c.url.includes("/v1/catalog/query");
    for (const c of searches) {
      expect(isZeroVarianceRepeatCapture(c, caps, isDeclared)).toBe(false);
    }
    for (const [i, c] of caps.entries()) {
      writeFileSync(
        join(runRoot, "graphql", `${String(i).padStart(3, "0")}-capture.json`),
        JSON.stringify(c)
      );
    }
    const siteId = `declared-post-facets-e2e-${process.pid}`;
    siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        submitEndpointPattern: "/v1/catalog/query",
        steps: [
          { step: "open catalog" },
          ...Array.from({ length: N }, (_, i) => ({
            step: stepName(i),
            payloadField: `group${i}Pick`,
            optional: true,
          })),
        ],
      })
    );
    const savedArgv = process.argv;
    const savedCwd = process.cwd();
    const warned: string[] = [];
    const spies = [
      ...(["log", "info", "warn", "error"] as const).map((k) =>
        vi.spyOn(console, k).mockImplementation((...a: unknown[]) => {
          warned.push(a.map(String).join(" "));
        })
      ),
      ...[process.stdout, process.stderr].map((st) =>
        vi.spyOn(st, "write").mockImplementation(((chunk: unknown) => {
          warned.push(String(chunk));
          return true;
        }) as never)
      ),
    ];
    try {
      process.chdir(RECON_GENERATE_CWD);
      process.argv = [
        "node",
        GENERATE_SCRIPT,
        "--site-id",
        siteId,
        "--run-dir",
        runRoot,
        "--emit",
        "ts",
        "--force",
      ];
      await main();
    } finally {
      process.argv = savedArgv;
      process.chdir(savedCwd);
      for (const sp of spies) sp.mockRestore();
    }
    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contract).not.toContain("ApplicantContactSchema");
    expect(contract).not.toContain("JobTrackingSchema");
    expect(contract).toContain("/v1/catalog/query");
    for (let i = 0; i < N; i++) expect(contract).toContain(`payload.group${i}Pick`);
    const log = warned.join("\n");
    expect(log).not.toMatch(/would freeze/i);
    expect(log).not.toMatch(/unread|never read|not read/i);
  }, 60_000);
});
