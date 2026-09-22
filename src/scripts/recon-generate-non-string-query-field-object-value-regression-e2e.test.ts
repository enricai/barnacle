import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Reproduces the report's exact archive shape: a capture whose top-level
 * `query` field was persisted as a JSON object rather than a string (a
 * legacy on-disk archive predating the disk-read normalization). Before the
 * fix, this crashed `recon:generate` with `query.replace is not a function`
 * once the value reached GraphQL-only string helpers.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.own-backend-non-string-query-fixture.example.com";
const THIRD_PARTY_ANALYTICS_HOST = "analytics.thirdparty-non-string-query-fixture.example.net";

const GRAPHQL_URL = `https://${OWN_BACKEND_HOST}/graphql`;
const ANALYTICS_URL = `https://${THIRD_PARTY_ANALYTICS_HOST}/collect`;

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate CLI — non-string `query` field on a legacy capture archive", () => {
  it("completes instead of crashing with `query.replace is not a function`", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-non-string-query-field-regression-e2e-"));
    const runRoot = join(workDir, "run");
    mkdirSync(join(runRoot, "graphql"), { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));

    const graphqlCapture = {
      ...buildCapture({
        url: GRAPHQL_URL,
        requestPostData: JSON.stringify({ query: "query Widget { widget { id } }" }),
        responseBody: { data: { widget: { id: "w1" } } },
        timestamp: "2024-01-01T00:00:00Z",
      }),
      // Reproduces the report's exact shape: a legacy archive whose `query`
      // field is a JSON object rather than a string.
      query: { identity: { fetch: ["widget"] } },
    };
    const analyticsCapture = buildCapture({
      url: ANALYTICS_URL,
      requestPostData: JSON.stringify({ event: "widget-view" }),
      responseBody: { ok: true },
      timestamp: "2024-01-01T00:00:01Z",
    });

    writeFileSync(join(runRoot, "graphql", "000-capture.json"), JSON.stringify(graphqlCapture));
    writeFileSync(join(runRoot, "graphql", "001-capture.json"), JSON.stringify(analyticsCapture));

    const siteId = `non-string-query-field-regression-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "fetch widget details", submitStep: true }],
        submitEndpointPattern: "graphql",
        requireSubmitEndpointMatch: true,
        ownBackendHostnames: [OWN_BACKEND_HOST],
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.stderr).not.toMatch(/query\.replace is not a function/);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contract).toMatch(/await httpClient\(/);
  }, 30_000);
});
