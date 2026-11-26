import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { RECON_GENERATE_CWD } from "@/scripts/recon-generate-cwd.test-helper";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");
const HOST = "www.latest-write-token-fixture.example.com";
const A = "tokenAAAA1111";
const B = "tokenBBBB2222";

function captures(): Capture[] {
  return [
    buildCapture({
      url: `https://${HOST}/docs/create/`,
      requestPostData: '{"title":"first"}',
      responseBody: { id: "doc-1", updatedAt: A },
      timestamp: "2026-01-01T00:00:00Z",
    }),
    buildCapture({
      url: `https://${HOST}/docs/update/`,
      requestPostData: JSON.stringify({ id: "doc-1", updatedAt: A, title: "second" }),
      responseBody: { id: "doc-1", updatedAt: B },
      timestamp: "2026-01-01T00:00:01Z",
    }),
    buildCapture({
      url: `https://${HOST}/docs/save/`,
      requestPostData: JSON.stringify({ id: "doc-1", updatedAt: B, title: "third" }),
      responseBody: { ok: true },
      timestamp: "2026-01-01T00:00:02Z",
    }),
  ];
}

let workDir: string | null = null;
let siteOutDir: string | null = null;
afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("write token binds to the latest carrying response", () => {
  it("PUT2 reads the PUT1 response var; PUT1 reads the create var", () => {
    workDir = mkdtempSync(join(tmpdir(), "latest-write-token-"));
    const runRoot = join(workDir, "run");
    for (const d of ["graphql", "replays", "aux"]) mkdirSync(join(runRoot, d), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), "[]");
    captures().forEach((c, i) =>
      writeFileSync(join(runRoot, "graphql", `00${i}-capture.json`), JSON.stringify(c))
    );
    const siteId = `latest-write-token-test-${process.pid}`;
    siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "create doc" }, { step: "update doc" }, { step: "save doc", submitStep: true }],
        submitEndpointPattern: "docs/save",
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
    const update = contract.match(/docs\/update\/[\s\S]*?body:\s*`([^`]*)`/)![1]!;
    const save = contract.match(/docs\/save\/[\s\S]*?body:\s*`([^`]*)`/)![1]!;
    const tok = (s: string) => s.match(/"updatedAt"\s*:\s*"?\$\{([^}]*)\}/)?.[1];
    expect(tok(update), update).toBeDefined();
    expect(tok(save), save).toBeDefined();
    expect(tok(update)).toMatch(/r0/);
    expect(tok(save)).toMatch(/r1/);
  }, 60_000);
});
