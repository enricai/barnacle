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
const HOST = "www.html-threaded-urls-fixture.example.com";
const JOB_PATH = "jobs/48213907/senior-widget-engineer";
const BOUNDARY = "----WebKitFormBoundaryabc123";
const CSRF = "Zk3mP9qR7vXc2LwN8bTy";
const HASH = "9f8e7d6c5b4a39281706";

function fixtureCaptures(): Capture[] {
  const page = buildCapture({
    url: `https://${HOST}/${JOB_PATH}/apply`,
    method: "GET",
    requestPostData: null,
    responseBody: `<html><form action="/${JOB_PATH}/step?csrf=${CSRF}&amp;hash=${HASH}" method="post"></form></html>`,
    timestamp: "2026-06-01T00:00:00Z",
  });
  const post = buildCapture({
    url: `https://${HOST}/${JOB_PATH}/step?csrf=${CSRF}&hash=${HASH}`,
    requestHeaders: { "Content-Type": `multipart/form-data; boundary=${BOUNDARY}` },
    requestPostData: null,
    responseBody: { ok: true },
    timestamp: "2026-06-01T00:00:01Z",
  });
  return [page, post];
}

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

describe("recon-generate CLI — HTML-issued values threaded into multipart step URLs", () => {
  it("threads csrf/hash and the ClickUrl job path into a multipart step URL", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-html-threaded-urls-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());
    const siteId = `html-threaded-urls-test${process.pid}`;
    siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "fill the email", payloadField: "Email" }],
        ownBackendHostnames: [HOST],
      })
    );
    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: RECON_GENERATE_CWD, encoding: "utf8" }
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contract).not.toContain(CSRF);
    expect(contract).not.toContain(HASH);
    expect(contract).toContain("new FormData()");
    expect(contract).toContain("const csrfToken");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder expanded from env by the code under test
    expect(contract).toContain("csrf=${csrfToken}&hash=${hashToken}");
    // The job path (id, slug) is read from payload.ClickUrl, not replayed.
    expect(contract).not.toContain("48213907");
    expect(contract).not.toContain("senior-widget-engineer");
    expect(contract).toContain('new URL(payload.ClickUrl).pathname.split("/")[2]');
  }, 30_000);
});
