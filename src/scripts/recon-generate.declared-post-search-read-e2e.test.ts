import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
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
});
