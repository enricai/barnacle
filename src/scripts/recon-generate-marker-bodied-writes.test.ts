import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { REQUEST_BODY_UNAVAILABLE } from "@/scraper/request-body-marker";
import { RECON_GENERATE_CWD } from "@/scripts/recon-generate-cwd.test-helper";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");
const HOST = "www.marker-bodied-writes.example.com";

let workDir: string | null = null;
let siteOutDir: string | null = null;
afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate — unavailable-body writes", () => {
  it("emits POST and PUT whose body is the marker, without leaking the marker", () => {
    workDir = mkdtempSync(join(tmpdir(), "marker-bodied-writes-"));
    const runRoot = join(workDir, "run");
    for (const d of ["graphql", "replays", "aux"]) mkdirSync(join(runRoot, d), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), "[]");
    const caps = [
      buildCapture({
        url: `https://${HOST}/cart/`,
        method: "POST",
        requestPostData: REQUEST_BODY_UNAVAILABLE,
        responseBody: { cartId: "cart-1" },
        timestamp: "2026-01-01T00:00:00Z",
      }),
      buildCapture({
        url: `https://${HOST}/cart/update/`,
        method: "PUT",
        requestPostData: REQUEST_BODY_UNAVAILABLE,
        responseBody: { ok: true },
        timestamp: "2026-01-01T00:00:01Z",
      }),
    ];
    caps.forEach((c, i) => {
      writeFileSync(join(runRoot, "graphql", `00${i}-capture.json`), JSON.stringify(c));
    });
    const siteId = `marker-bodied-writes-test-${process.pid}`;
    siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "add to cart" }, { step: "update cart", submitStep: true }],
        submitEndpointPattern: "cart/update",
        requireSubmitEndpointMatch: true,
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
    expect(contract).toContain("/cart/");
    expect(contract).toContain("/cart/update/");
    expect(contract).toMatch(/PUT/);
    expect(contract).not.toContain(REQUEST_BODY_UNAVAILABLE);
  }, 60_000);

  it("handles a null-body GET alongside marker-bodied writes", () => {
    workDir = mkdtempSync(join(tmpdir(), "marker-bodied-null-get-"));
    const runRoot = join(workDir, "run");
    for (const d of ["graphql", "replays", "aux"]) mkdirSync(join(runRoot, d), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), "[]");
    const caps = [
      buildCapture({
        url: `https://${HOST}/cart/view/`,
        method: "GET",
        requestPostData: null,
        responseBody: { items: [] },
        timestamp: "2025-12-31T23:59:59Z",
      }),
      buildCapture({
        url: `https://${HOST}/cart/`,
        method: "POST",
        requestPostData: REQUEST_BODY_UNAVAILABLE,
        responseBody: { cartId: "cart-1" },
        timestamp: "2026-01-01T00:00:00Z",
      }),
      buildCapture({
        url: `https://${HOST}/cart/update/`,
        method: "PUT",
        requestPostData: REQUEST_BODY_UNAVAILABLE,
        responseBody: { ok: true },
        timestamp: "2026-01-01T00:00:01Z",
      }),
    ];
    caps.forEach((c, i) => {
      writeFileSync(join(runRoot, "graphql", `10${i}-capture.json`), JSON.stringify(c));
    });
    const siteId = `marker-null-get-test-${process.pid}`;
    siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "add to cart" }, { step: "update cart", submitStep: true }],
        submitEndpointPattern: "cart/update",
        requireSubmitEndpointMatch: true,
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
    expect(contract).toContain("/cart/");
    expect(contract).toContain("/cart/update/");
    expect(contract).toMatch(/PUT/);
    expect(contract).not.toContain(REQUEST_BODY_UNAVAILABLE);
  }, 60_000);
});
