import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { RECON_GENERATE_CWD } from "@/scripts/recon-generate-cwd.test-helper";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

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

describe("recon-generate end to end: origin-bearing entry-URL params never mint payload keys", () => {
  it("does not expose an origin-bearing entry query value as a payload field", () => {
    const HOST = "www.origin-never-payload-fixture.example.com";
    const ORIGIN = `https://${HOST}`;
    workDir = mkdtempSync(join(tmpdir(), "barnacle-origin-payload-"));
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
    const siteId = `origin-never-payload-test-${process.pid}`;
    siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
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
    const r = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: RECON_GENERATE_CWD, encoding: "utf8" }
    );
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contract).toContain("catalog-detail/");
    // The origin is templated from runtime context, never a literal or payload field.
    expect(contract).not.toContain(HOST);
    expect(contract).not.toMatch(/(payload|data|params)\??\.returnUrl|["']?returnUrl["']?\s*:/i);
  });
});
