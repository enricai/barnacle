import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

const REPO_ROOT = join(__dirname, "..", "..");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("recon-generate in-process — declared submit pattern with incidental POSTs", () => {
  it("runs the incidental-read-flow classification for non-submit POSTs and still emits a contract", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "barnacle-incidental-"));
    dirs.push(workDir);
    const runRoot = join(workDir, "run");
    const capturesDir = join(runRoot, "graphql");
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
    const caps = [
      buildCapture({
        url: "https://api.example.com/items/1",
        requestPostData: null,
        responseBody: { id: 1, name: "widget" },
        timestamp: "2024-02-01T00:00:00Z",
        method: "GET",
      }),
      buildCapture({
        url: "https://api.example.com/analytics/one",
        requestPostData: JSON.stringify({ e: "view" }),
        responseBody: { ok: true },
        timestamp: "2024-02-01T00:00:01Z",
      }),
      buildCapture({
        url: "https://api.example.com/analytics/two",
        requestPostData: JSON.stringify({ e: "consent" }),
        responseBody: { ok: true },
        timestamp: "2024-02-01T00:00:02Z",
      }),
      buildCapture({
        url: "https://api.example.com/catalog/submit",
        requestPostData: JSON.stringify({ confirm: true }),
        responseBody: { ok: true },
        timestamp: "2024-02-01T00:00:03Z",
      }),
    ];
    for (const [i, c] of caps.entries())
      writeFileSync(join(capturesDir, `00${i}-cap.json`), JSON.stringify(c));
    const siteId = `incidental-post-ip-${process.pid}`;
    const siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    dirs.push(siteOutDir);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "open the page" }, { step: "view the item" }],
        submitEndpointPattern: "catalog/submit",
        ownBackendHostnames: ["api.example.com"],
      })
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
      expect(existsSync(out)).toBe(true);
      expect(readFileSync(out, "utf8").length).toBeGreaterThan(0);
    } finally {
      process.argv = origArgv;
    }
  }, 60_000);
});
