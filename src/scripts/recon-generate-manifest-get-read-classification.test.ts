import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function generate(urls: string[], flowExtra: Record<string, unknown> = {}): string {
  const workDir = mkdtempSync(join(tmpdir(), "barnacle-manifest-get-"));
  dirs.push(workDir);
  const runRoot = join(workDir, "run");
  const capturesDir = join(runRoot, "graphql");
  mkdirSync(capturesDir, { recursive: true });
  mkdirSync(join(runRoot, "replays"), { recursive: true });
  mkdirSync(join(runRoot, "aux"), { recursive: true });
  writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
  urls.forEach((url, i) => {
    writeFileSync(
      join(capturesDir, `00${i}-read.json`),
      JSON.stringify(
        buildCapture({
          url,
          requestPostData: null,
          responseBody: { id: i + 1, name: "widget", token: "tok-9f8e7d6c5b4a" },
          timestamp: `2024-02-0${i + 1}T00:00:00Z`,
          method: "GET",
        })
      )
    );
  });
  const siteId = `manifest-get-read-test-${process.pid}-${dirs.length}`;
  const siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
  dirs.push(siteOutDir);
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({ steps: [{ step: "open the page" }, { step: "view the item" }], ...flowExtra })
  );
  const result = spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return readFileSync(join(siteOutDir, "contract.ts"), "utf8");
}

describe("recon-generate — manifest of 2xx GETs with differing path shapes", () => {
  it("is a read-only GET flow: HTTP hot path, no job tracking", () => {
    const contract = generate([
      "https://api.example.com/items/1",
      "https://api.example.com/items/2/details",
      "https://api.example.com/categories/books?page=2",
      "https://api.example.com/search?q=widget",
      "https://api.example.com/orders/tok-9f8e7d6c5b4a/lines",
    ]);
    expect(contract).toContain("async executeHttp(");
    expect(contract).not.toContain("JobTracking");
  }, 60_000);

  it("declared submit pattern selecting non-sibling GETs still reads, not a job", () => {
    const contract = generate(
      [
        "https://api.example.com/items/1",
        "https://api.example.com/catalog/books/featured/list",
        "https://api.example.com/users/me",
      ],
      { submitEndpointPattern: "/(items|catalog|users)/" }
    );
    expect(contract).toContain("async executeHttp(");
    // Read samples replay as a GET against the endpoint, never a POST `{query}` submission.
    expect(contract).toContain('method: "GET"');
    expect(contract).not.toContain('method: "POST"');
    expect(contract).not.toContain("JobTracking");
  }, 60_000);
});
