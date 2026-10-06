import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * A scalar navigateTo facet literal recurring once flanked by alphanumerics in
 * an unrelated token and once as a whole body leaf must still bind the whole
 * leaf at every call site and leave the unrelated token untouched.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.scalar-facet-collision-fixture.example.com";
const BRAND = "acme";

function writeRunDir(root: string, captures: Capture[]): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));
  captures.forEach((capture, index) => {
    writeFileSync(
      join(root, "graphql", `${String(index).padStart(3, "0")}-capture.json`),
      JSON.stringify(capture)
    );
  });
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate CLI — scalar navigateTo facet binds per whole leaf despite a colliding token", () => {
  it("binds every whole-leaf occurrence at every call site and leaves the flanked token untouched", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-scalar-facet-collision-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, [
      buildCapture({
        url: `https://${OWN_BACKEND_HOST}/catalog/browse/`,
        requestPostData: JSON.stringify({ brand: BRAND }),
        responseBody: { ok: true },
        timestamp: "2026-03-01T00:00:00.000Z",
      }),
      buildCapture({
        url: `https://${OWN_BACKEND_HOST}/catalog/filter-results/`,
        requestPostData: JSON.stringify({ filter: { brand: BRAND, sku: "acmebolt" } }),
        responseBody: { ok: true },
        timestamp: "2026-03-01T00:00:01.000Z",
      }),
    ]);

    const siteId = `scalar-facet-collision-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          {
            step: "navigate to the brand catalog page",
            navigateTo: `https://${OWN_BACKEND_HOST}/#/catalog/brand/${BRAND}`,
            payloadField: "BrandFacet",
          },
          { step: "browse catalog" },
          { step: "apply filters", submitStep: true },
        ],
        submitEndpointPattern: "catalog/filter-results",
        requireSubmitEndpointMatch: true,
        ownBackendHostnames: [OWN_BACKEND_HOST],
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    const bodies = [...contract.matchAll(/body:\s*`([^`]*)`,/g)].map((m) => m[1] ?? "");
    expect(bodies.length, contract).toBeGreaterThan(1);
    const combined = bodies.join("\n");
    expect(combined).toContain("acmebolt");
    expect(combined.replace(/acmebolt/g, "")).not.toContain(BRAND);
    expect(combined.match(/\$\{payload\.BrandFacet\}/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(contract).toMatch(/ {2}BrandFacet:/);
  }, 30_000);
});
