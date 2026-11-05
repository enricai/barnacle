import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("recon-generate — multi-step flow of successful GET reads", () => {
  it("is generated as a single-endpoint REST read, not a browser-only submission flow", () => {
    const workDir = mkdtempSync(join(tmpdir(), "barnacle-get-read-"));
    dirs.push(workDir);
    const runRoot = join(workDir, "run");
    const capturesDir = join(runRoot, "graphql");
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
    writeFileSync(
      join(capturesDir, "000-read.json"),
      JSON.stringify(
        buildCapture({
          url: "https://api.example.com/items/1",
          requestPostData: null,
          responseBody: { id: 1, name: "widget" },
          timestamp: "2024-02-01T00:00:00Z",
          method: "GET",
        })
      )
    );
    const siteId = `get-read-flow-test-${process.pid}`;
    const siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    dirs.push(siteOutDir);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({ steps: [{ step: "open the page" }, { step: "view the item" }] })
    );
    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status, output).toBe(0);
    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    // Single-endpoint REST read: an HTTP hot path against the GET endpoint.
    expect(contract).toContain("async executeHttp(");
    // The entity id in the path is a caller input; the recording is only its fallback.
    expect(contract).toContain('payload.itemsId ?? "1"');
  }, 60_000);

  it("a flow of schedule GET captures is a single-endpoint REST read; the URL guard ignores the response schema", () => {
    const workDir = mkdtempSync(join(tmpdir(), "barnacle-get-sched-"));
    dirs.push(workDir);
    const runRoot = join(workDir, "run");
    const capturesDir = join(runRoot, "graphql");
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
    const windows = [
      ["2030-01-07", "2030-01-13"],
      ["2030-01-14", "2030-01-20"],
    ];
    windows.forEach(([from, to], i) => {
      writeFileSync(
        join(capturesDir, `00${i}-read.json`),
        JSON.stringify(
          buildCapture({
            url: `https://example.com/venues/9/schedule.json?room_ids%5B%5D=9&date_from=${from}&date_to=${to}`,
            requestPostData: null,
            responseBody: { slots: [{ id: i + 1 }], mapUrl: "https://example.com/map" },
            timestamp: `2024-02-0${i + 1}T00:00:00Z`,
            method: "GET",
          })
        )
      );
    });
    const siteId = `get-sched-flow-test-${process.pid}`;
    const siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    dirs.push(siteOutDir);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({ steps: [{ step: "open the page" }, { step: "view the schedule" }] })
    );
    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status, output).toBe(0);
    expect(result.stdout).toContain("single-endpoint REST");
    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contract).toContain("async executeHttp(");
    expect(contract).toContain("payload.date_from");
    expect(contract).toContain("payload.date_to");
  }, 60_000);

  it("in-process: main() selects the GET endpoint (covered path)", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "barnacle-get-read-ip-"));
    dirs.push(workDir);
    const runRoot = join(workDir, "run");
    const capturesDir = join(runRoot, "graphql");
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
    writeFileSync(
      join(capturesDir, "000-read.json"),
      JSON.stringify(
        buildCapture({
          url: "https://api.example.com/items/2",
          requestPostData: null,
          responseBody: { id: 2, name: "gadget" },
          timestamp: "2024-02-01T00:00:00Z",
          method: "GET",
        })
      )
    );
    const siteId = `get-read-flow-ip-${process.pid}`;
    const siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    dirs.push(siteOutDir);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({ steps: [{ step: "open the page" }, { step: "view the item" }] })
    );
    const origArgv = process.argv;
    process.argv = [
      origArgv[0] ?? "node",
      GENERATE_SCRIPT,
      "--site-id",
      siteId,
      "--run-dir",
      runRoot,
      "--emit",
      "ts",
      "--force",
    ];
    vi.resetModules();
    try {
      await import("./recon-generate.js");
      const out = join(siteOutDir, "contract.ts");
      for (let i = 0; i < 300 && !existsSync(out); i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      await new Promise((r) => setTimeout(r, 500));
      const contract = readFileSync(out, "utf8");
      expect(contract).toContain("async executeHttp(");
      expect(contract).toContain('payload.itemsId ?? "2"');
    } finally {
      process.argv = origArgv;
    }
  }, 60_000);

  it("binds the browser fallback extract prompt to the derived payload fields", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "barnacle-get-read-bf-"));
    dirs.push(workDir);
    const runRoot = join(workDir, "run");
    const capturesDir = join(runRoot, "graphql");
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
    for (const [n, q] of [
      ["000", "alpha"],
      ["001", "beta"],
    ] as const) {
      writeFileSync(
        join(capturesDir, `${n}-read.json`),
        JSON.stringify(
          buildCapture({
            url: `https://api.example.com/search?term=${q}`,
            requestPostData: null,
            responseBody: { id: 1, name: q },
            timestamp: `2024-02-01T00:00:0${n.slice(-1)}Z`,
            method: "GET",
          })
        )
      );
    }
    const siteId = `get-read-flow-bf-${process.pid}`;
    const siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    dirs.push(siteOutDir);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({ steps: [{ step: "open the page" }, { step: "view the item" }] })
    );
    const origArgv = process.argv;
    process.argv = [
      origArgv[0] ?? "node",
      GENERATE_SCRIPT,
      "--site-id",
      siteId,
      "--run-dir",
      runRoot,
      "--emit",
      "ts",
      "--force",
    ];
    vi.resetModules();
    let flow: string;
    try {
      await import("./recon-generate.js");
      const out = join(siteOutDir, "flows", "browser-flow.ts");
      for (let i = 0; i < 300 && !existsSync(out); i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      await new Promise((r) => setTimeout(r, 500));
      flow = readFileSync(out, "utf8");
    } finally {
      process.argv = origArgv;
    }
    expect(flow).toContain("payload.term");
    expect(flow).not.toContain('"extract the results shown on the page"');
  }, 60_000);
});
