import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { ReplayResult } from "@/scripts/recon-shared";

/**
 * Regression guard for the filed report: recon-generate must derive the
 * emitted ResponseSchema from the primary operation's own Phase-1 capture,
 * never from replay array order. Generating twice from the same run dir --
 * once before recon:http replay artifacts exist, once after -- must emit an
 * identical, non-scalar ResponseSchema both times, even when an unrelated
 * replay whose body is a plain string sorts before the primary operation's
 * own replay.
 *
 * Exercises the real CLI (`tsx recon-generate.ts`), matching
 * recon-generate-graphql-readonly-e2e.test.ts.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const PRIMARY_URL = "https://www.catalog-fixture.example.com/graph";
const OTHER_URL = "https://www.catalog-fixture.example.com/notifications/graph";

function gqlCapture(overrides: {
  phase: string;
  url: string;
  operationName: string | null;
  query: string | null;
  variables: Record<string, unknown> | null;
  responseBody: unknown;
}) {
  return {
    timestamp: "2026-08-18T10:23:03.000Z",
    phase: overrides.phase,
    method: "POST",
    url: overrides.url,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: "{}",
    responseHeaders: {},
    responseBody: overrides.responseBody,
    operationName: overrides.operationName,
    query: overrides.query,
    variables: overrides.variables,
    decodedParams: null,
  };
}

function writeRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });

  const catalogListing = gqlCapture({
    phase: "browse-the-catalog",
    url: PRIMARY_URL,
    operationName: "catalogListing",
    query: "query catalogListing { items { id name } }",
    variables: null,
    responseBody: { items: [{ id: "1", name: "widget" }] },
  });

  writeFileSync(
    join(root, "graphql", "000-browse-the-catalog-action.json"),
    JSON.stringify(catalogListing)
  );
}

function writeReplayResult(root: string, name: string, overrides: Partial<ReplayResult>): void {
  const replay: ReplayResult = {
    sourceCapture: "000-browse-the-catalog-action.json",
    url: PRIMARY_URL,
    method: "POST",
    operationName: "catalogListing",
    requestBody: "{}",
    replayStatus: 200,
    replayHeaders: {},
    replayBody: { items: [{ id: "1", name: "widget" }] },
    success: true,
    error: null,
    ...overrides,
  };
  writeFileSync(join(root, "replays", name), JSON.stringify(replay));
}

function extractResponseSchemaLine(contract: string): string {
  const match = contract.match(
    /^const \w+ResponseSchema = ([\s\S]+?);\n\nexport type \w+Response = /m
  );
  if (!match?.[1]) throw new Error(`no ResponseSchema declaration found in contract:\n${contract}`);
  return match[1];
}

function runGenerate(runRoot: string, siteId: string, extraArgs: string[] = []): string {
  const siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
  const result = spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", ...extraArgs],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return readFileSync(join(siteOutDir, "contract.ts"), "utf8");
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate ResponseSchema: stable across pre-replay and post-replay runs", () => {
  it("emits the same non-scalar ResponseSchema before and after recon:http replay artifacts exist, even when an unrelated string-body replay sorts first", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-response-schema-replay-stability-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `response-schema-replay-stability-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);

    // Run 1: no replay artifacts yet.
    const contractBeforeReplay = runGenerate(runRoot, siteId);
    const schemaBeforeReplay = extractResponseSchemaLine(contractBeforeReplay);

    expect(schemaBeforeReplay).not.toBe("z.string()");
    expect(contractBeforeReplay).toContain("catalogListing");

    rmSync(siteOutDir, { recursive: true, force: true });

    // Run 2: replay artifacts now exist. An unrelated, alphabetically-earlier
    // replay for a DIFFERENT endpoint whose body is a plain string reproduces
    // the report's "wrong body surfaces first" scenario, plus the primary
    // operation's own successful replay.
    writeReplayResult(runRoot, "000-other-notifications.json", {
      sourceCapture: "999-unrelated-notifications-action.json",
      url: OTHER_URL,
      operationName: "notificationsBanner",
      replayBody: "ok",
    });
    writeReplayResult(runRoot, "001-primary-catalog.json", {});

    const contractAfterReplay = runGenerate(runRoot, siteId, ["--force"]);
    const schemaAfterReplay = extractResponseSchemaLine(contractAfterReplay);

    expect(schemaAfterReplay).toBe(schemaBeforeReplay);
    expect(schemaAfterReplay).not.toBe("z.string()");
  }, 30_000);
});
