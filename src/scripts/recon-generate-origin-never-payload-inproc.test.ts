import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { RECON_GENERATE_CWD } from "@/scripts/recon-generate-cwd.test-helper";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

/**
 * In-process twin of the subprocess e2e: loads the CLI module with argv[1]
 * pointing at it so `main()` runs under the test runner (and its coverage),
 * exercising the `extractEntryUrlParams(..., baseUrl)` call site.
 */
const SCRIPT = join(__dirname, "recon-generate.ts");
const dirs: string[] = [];
const origArgv = process.argv;
const origCwd = process.cwd();
afterEach(() => {
  process.argv = origArgv;
  process.chdir(origCwd);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.resetModules();
});

describe("recon-generate main() in-process: origin-bearing entry param", () => {
  it("never mints a payload key from an origin-bearing entry query value", async () => {
    const HOST = "www.origin-inproc-fixture.example.com";
    const ORIGIN = `https://${HOST}`;
    const workDir = mkdtempSync(join(tmpdir(), "barnacle-origin-inproc-"));
    dirs.push(workDir);
    const runRoot = join(workDir, "run");
    for (const d of ["graphql", "replays", "aux"]) mkdirSync(join(runRoot, d), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), "[]");
    const caps = [
      buildCapture({
        url: `${ORIGIN}/catalog-search/?returnUrl=${encodeURIComponent(`${ORIGIN}/cart/items/checkout`)}`,
        requestPostData: JSON.stringify({ q: "widgets" }),
        responseBody: { results: [{ id: "item-1" }] },
        timestamp: "2026-01-01T00:00:00Z",
      }),
      buildCapture({
        url: `${ORIGIN}/catalog-detail/`,
        requestPostData: JSON.stringify({ id: "item-1" }),
        responseBody: { detail: { id: "item-1" } },
        timestamp: "2026-01-01T00:00:01Z",
      }),
    ];
    caps.forEach((c, i) =>
      writeFileSync(join(runRoot, "graphql", `${String(i).padStart(3, "0")}-capture.json`), JSON.stringify(c))
    );
    const siteId = `origin-inproc-test-${process.pid}`;
    const siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
    dirs.push(siteOutDir);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "search catalog" }, { step: "view item detail", submitStep: true }],
        submitEndpointPattern: "catalog-detail",
        requireSubmitEndpointMatch: true,
        ownBackendHostnames: [HOST],
      })
    );
    process.chdir(RECON_GENERATE_CWD);
    process.argv = [
      process.argv[0] ?? "node",
      SCRIPT,
      "--site-id",
      siteId,
      "--run-dir",
      runRoot,
      "--emit",
      "ts",
      "--force",
    ];
    await import("@/scripts/recon-generate");
    const contractPath = join(siteOutDir, "contract.ts");
    await vi.waitFor(() => expect(existsSync(contractPath)).toBe(true), { timeout: 20000 });
    await new Promise((r) => setTimeout(r, 500));
    const contract = readFileSync(contractPath, "utf8");
    expect(contract).toContain("catalog-detail/");
    expect(contract).not.toMatch(/(payload|data|params)\??\.returnUrl|["']?returnUrl["']?\s*:/i);
  });
});
