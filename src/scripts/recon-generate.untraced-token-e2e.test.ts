import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { RECON_GENERATE_CWD } from "@/scripts/recon-generate-cwd.test-helper";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * A multi-step stateful flow re-sends per-request tokens in later URLs. The
 * generated plugin must either thread each token from the response that issued
 * it, or — when no step the plugin can re-run produces it — ship browser-only.
 * It must never bake the recording's literal into `executeHttp`.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");
const HOST = "www.untraced-token-e2e-fixture.example.com";
const TOK = "Qw8rT5yU2iO9pLkJ4hGf";
const B64 = "ab+cd/ef12GH34ij56KL==";
const at = (n: number) => `2026-06-01T00:00:0${n}Z`;

const page = (path: string, body: unknown, n: number) =>
  buildCapture({
    url: `https://${HOST}${path}`,
    method: "GET",
    requestPostData: null,
    responseBody: body,
    timestamp: at(n),
  });
const write = (path: string, body: unknown, response: unknown, n: number) =>
  buildCapture({
    url: `https://${HOST}${path}`,
    requestPostData: JSON.stringify(body),
    responseBody: response,
    timestamp: at(n),
  });

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

function generate(tag: string, captures: Capture[]): string {
  workDir = mkdtempSync(join(tmpdir(), "barnacle-untraced-token-e2e-"));
  const runRoot = join(workDir, "run");
  for (const dir of ["graphql", "replays", "aux"])
    mkdirSync(join(runRoot, dir), { recursive: true });
  writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
  captures.forEach((capture, index) => {
    writeFileSync(
      join(runRoot, "graphql", `${String(index).padStart(3, "0")}-capture.json`),
      JSON.stringify(capture)
    );
  });
  const siteId = `untraced-token-${tag}${process.pid}`;
  siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({ steps: [{ step: "browse" }], ownBackendHostnames: [HOST] })
  );
  const result = spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
    { cwd: RECON_GENERATE_CWD, encoding: "utf8" }
  );
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return readFileSync(join(siteOutDir, "contract.ts"), "utf8");
}

describe("recon-generate CLI — per-request tokens in a multi-step flow", () => {
  it("threads a JSON-issued token re-sent percent-encoded in a later URL", () => {
    const contract = generate("json", [
      write("/api/start", { a: 1 }, { handle: B64 }, 0),
      write("/api/step", { b: 2 }, { ok: true }, 1),
      write(`/api/commit?handle=${encodeURIComponent(B64)}`, { q: 1 }, { ok: true }, 2),
    ]);
    expect(contract).not.toContain(B64);
    expect(contract).not.toContain(encodeURIComponent(B64));
    expect(contract).toContain("executeHttp(");
    expect(contract).toContain("encodeURIComponent(handle)");
  }, 60_000);

  it("threads a hidden-input token only the preceding HTML page carried", () => {
    const contract = generate("hidden", [
      page("/apply", `<html><input type="hidden" name="nonce" value="${TOK}"></html>`, 0),
      write("/api/step", { b: 2 }, { ok: true }, 1),
      write("/api/commit", { nonce: TOK }, { ok: true }, 2),
    ]);
    expect(contract).not.toContain(TOK);
    expect(contract).toContain("const nonceToken");
  }, 60_000);

  it("ships browser-only rather than freezing a token only markup carried", () => {
    const contract = generate("markup", [
      page("/apply", `<html><script>var s = "${TOK}";</script></html>`, 0),
      write("/api/step", { b: 2 }, { ok: true }, 1),
      write(`/api/commit?s=${TOK}`, { q: 1 }, { ok: true }, 2),
    ]);
    expect(contract).not.toContain(TOK);
    expect(contract).not.toContain("async executeHttp(");
  }, 60_000);

  it("ships browser-only rather than freezing a one-off opaque URL token nothing issued", () => {
    const contract = generate("oneoff", [
      write("/api/start", { a: 1 }, { ok: true }, 0),
      write("/api/step", { b: 2 }, { ok: true }, 1),
      write(`/api/commit?sid=${TOK}`, { q: 1 }, { ok: true }, 2),
    ]);
    expect(contract).not.toContain(TOK);
    expect(contract).not.toContain("async executeHttp(");
  }, 60_000);
});
