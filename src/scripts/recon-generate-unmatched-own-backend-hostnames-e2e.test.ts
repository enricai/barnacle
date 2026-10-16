import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { deriveBaseUrl } from "@/scripts/recon-generate";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Locks in that declared ownBackendHostnames matching no capture fails
 * generation loudly rather than emitting the placeholder origin as baseUrl,
 * while a matching hostname still yields the right base URL.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_HOST = "api.shop-demo.test";
const OTHER_HOST = "cdn.other-demo.test";
const PLACEHOLDER_ORIGIN = "https://example.com";

function capture(host: string): Capture {
  return {
    timestamp: "2026-01-01T00:00:00.000Z",
    phase: "filter",
    method: "POST",
    url: `https://${host}/graphql`,
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: { "content-type": "application/json" },
    operationName: null,
    query: "query SearchResults($filters: String) { results(filters: $filters) { id name } }",
    variables: { filters: "category:widgets" },
    responseBody: { results: [{ id: "1", name: "Widget" }] },
    decodedParams: null,
  };
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

function runGenerate(
  captureHost: string,
  declaredHosts: string[]
): { status: number | null; output: string; contractPath: string } {
  workDir = mkdtempSync(join(tmpdir(), "barnacle-recon-unmatched-own-backend-e2e-"));
  const runRoot = join(workDir, "run");
  const capturesDir = join(runRoot, "graphql");
  mkdirSync(capturesDir, { recursive: true });
  mkdirSync(join(runRoot, "replays"), { recursive: true });
  mkdirSync(join(runRoot, "aux"), { recursive: true });
  writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
  writeFileSync(join(capturesDir, "000-capture.json"), JSON.stringify(capture(captureHost)));

  const siteId = `recon-unmatched-own-backend-e2e-test-${process.pid}`;
  siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({ ownBackendHostnames: declaredHosts, steps: [] })
  );

  const result = spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
  return {
    status: result.status,
    output: `${result.stdout}\n${result.stderr}`,
    contractPath: join(siteOutDir, "contract.ts"),
  };
}

describe("recon-generate unmatched ownBackendHostnames", () => {
  it("deriveBaseUrl throws instead of returning the placeholder origin", () => {
    expect(() => deriveBaseUrl([capture(OTHER_HOST)], [OWN_HOST])).toThrow(
      /ownBackendHostnames matched no capture/
    );
  });

  it("CLI exits non-zero and writes no contract with the placeholder origin", () => {
    const { status, output, contractPath } = runGenerate(OTHER_HOST, [OWN_HOST]);

    expect(status, output).not.toBe(0);
    expect(output).toContain("ownBackendHostnames matched no capture");
    if (existsSync(contractPath)) {
      expect(readFileSync(contractPath, "utf8")).not.toContain(PLACEHOLDER_ORIGIN);
    }
  }, 30_000);

  it("CLI exits 0 with the matching host's origin in baseUrl", () => {
    const { status, output, contractPath } = runGenerate(OWN_HOST, [OWN_HOST]);

    expect(status, output).toBe(0);
    const contract = readFileSync(contractPath, "utf8");
    expect(contract).toContain(`https://${OWN_HOST}`);
    expect(contract).not.toContain(PLACEHOLDER_ORIGIN);
  }, 30_000);
});
