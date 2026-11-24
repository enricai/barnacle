import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { RECON_GENERATE_CWD } from "@/scripts/recon-generate-cwd.test-helper";

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

const cap = (url: string, method: string, body: unknown, postData?: string) => ({
  url,
  method,
  status: 200,
  requestHeaders: { "content-type": "application/json" },
  ...(postData ? { requestPostData: postData } : {}),
  responseBody: JSON.stringify(body),
  responseHeaders: { "content-type": "application/json" },
});

describe("recon-generate: endpoint is chosen from submit-manifest captures", () => {
  it("does not pick an unlisted one-off POST beacon on the same host", () => {
    workDir = mkdtempSync(join(tmpdir(), "manifest-scoped-endpoint-"));
    const runRoot = join(workDir, "run");
    const dir = join(runRoot, "graphql");
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), "[]");
    const captures = [
      cap("https://api.example-manifest.test/v1/jobs/alpha", "GET", { id: "a", title: "A" }),
      cap("https://api.example-manifest.test/v1/jobs/beta", "GET", { id: "b", title: "B" }),
      cap(
        "https://api.example-manifest.test/v1/collect-beacon",
        "POST",
        { ok: true },
        '{"event":"view"}'
      ),
    ];
    const names = captures.map((_, i) => `${String(i).padStart(3, "0")}-read.json`);
    for (const [i, c] of captures.entries()) {
      writeFileSync(join(dir, names[i] as string), JSON.stringify(c));
    }
    writeFileSync(
      join(runRoot, "submit-manifest.json"),
      JSON.stringify([0, 1].map((i) => ({ index: i, filename: names[i], url: captures[i]?.url })))
    );
    const siteId = `manifest-scoped-endpoint-test-${process.pid}`;
    siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
    const r = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: RECON_GENERATE_CWD, encoding: "utf8" }
    );
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contract).toContain("/v1/jobs/");
    expect(contract).not.toContain("collect-beacon");
  }, 120000);
});
