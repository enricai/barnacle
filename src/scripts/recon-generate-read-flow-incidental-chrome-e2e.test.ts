import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { RECON_GENERATE_CWD } from "@/scripts/recon-generate-cwd.test-helper";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * A flow declaring a submit pattern that matches only a GET read is a
 * read-only REST flow. Same-origin chrome (a token-mint GET, analytics POST
 * beacons whose tokens only feed each other) is not a step. When the declared
 * read itself re-sends the mint's token, the mint IS a step.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const HOST = "www.example-shop.test";
const ORIGIN = `https://${HOST}`;
const MINT_TOKEN = "6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5";
const VISIT_TOKEN = "visit-token-5d1e77a0c4b9";
const VISITOR_TOKEN = "visitor-token-92ab3c4d5e6f";

function get(
  url: string,
  responseBody: unknown,
  timestamp: string,
  headers?: Record<string, string>,
) {
  return buildCapture({
    method: "GET",
    url,
    requestPostData: null,
    responseBody,
    timestamp,
    ...(headers ? { requestHeaders: headers } : {}),
  });
}

function fixtureCaptures(readSendsMintToken: boolean): Capture[] {
  const mint = get(
    `${ORIGIN}/open-slots-token.json`,
    { csrf: { token: MINT_TOKEN, param: "authenticity_token" } },
    "2026-01-01T00:00:00Z",
  );
  const visits = buildCapture({
    url: `${ORIGIN}/a/visits`,
    requestPostData: JSON.stringify({ landing_page: `${ORIGIN}/rooms/7` }),
    responseBody: { visit_token: VISIT_TOKEN, visitor_token: VISITOR_TOKEN },
    timestamp: "2026-01-01T00:00:01Z",
  });
  const events = buildCapture({
    url: `${ORIGIN}/a/events`,
    requestPostData: JSON.stringify({
      visit_token: VISIT_TOKEN,
      visitor_token: VISITOR_TOKEN,
      name: "$view",
      ...(readSendsMintToken ? { authenticity_token: MINT_TOKEN } : {}),
    }),
    responseBody: { ok: true },
    timestamp: "2026-01-01T00:00:02Z",
  });
  const readUrl =
    `${ORIGIN}/rooms/7/open-slots.json?room_ids[]=7&date_from=2026-11-22&date_to=2026-11-28` +
    (readSendsMintToken ? `&authenticity_token=${MINT_TOKEN}` : "");
  const read = get(
    readUrl,
    { slots: [{ time: "10:00", price: 30 }] },
    "2026-01-01T00:00:03Z",
  );
  return [mint, visits, events, read];
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

function generate(readSendsMintToken: boolean, tag: string) {
  workDir = mkdtempSync(
    join(tmpdir(), "barnacle-read-flow-incidental-chrome-e2e-"),
  );
  const runRoot = join(workDir, "run");
  mkdirSync(join(runRoot, "graphql"), { recursive: true });
  mkdirSync(join(runRoot, "replays"), { recursive: true });
  mkdirSync(join(runRoot, "aux"), { recursive: true });
  writeFileSync(
    join(runRoot, "replays", "rate-limit.json"),
    JSON.stringify([]),
  );
  fixtureCaptures(readSendsMintToken).forEach((capture, index) => {
    writeFileSync(
      join(
        runRoot,
        "graphql",
        `${String(index).padStart(3, "0")}-capture.json`,
      ),
      JSON.stringify(capture),
    );
  });

  const siteId = `read-flow-incidental-chrome-${tag}-e2e-test${process.pid}`;
  siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({
      steps: [
        { step: "open the schedule section", optional: true },
        { step: "pick a later date range", optional: true },
        { step: "change the group size", optional: true },
      ],
      submitEndpointPattern: "/open-slots.json",
      requireSubmitEndpointMatch: true,
      ownBackendHostnames: [HOST],
    }),
  );

  if (!existsSync(TSX_BIN)) throw new Error("tsx not installed");
  const result = spawnSync(
    TSX_BIN,
    [
      GENERATE_SCRIPT,
      "--site-id",
      siteId,
      "--run-dir",
      runRoot,
      "--emit",
      "ts",
      "--force",
    ],
    { cwd: RECON_GENERATE_CWD, encoding: "utf8" },
  );
  const output = `${result.stdout}\n${result.stderr}`;
  expect(result.status, output).toBe(0);
  const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
  return { output, contract };
}

describe("recon-generate CLI — read flow with incidental same-origin chrome", () => {
  it("emits a single-endpoint REST read when the token mint and analytics beacons feed nothing declared", () => {
    const { output, contract } = generate(false, "chrome");
    expect(output).toContain("single-endpoint REST");
    expect(output).not.toContain("browser-flow-only");
    expect(output).not.toContain("falling back to a browser-only plugin");
    expect(contract).toContain("open-slots.json");
    expect(contract).toMatch(/room_ids/);
    expect(contract).toMatch(/date_from/);
    expect(contract).toMatch(/date_to/);
    expect(contract).not.toContain("/a/visits");
    expect(contract).not.toContain("session-token.json");
  }, 60_000);

  it("keeps the mint as a step when the declared read re-sends its token", () => {
    const { output } = generate(true, "mint-feeds");
    expect(output).not.toContain("single-endpoint REST");
    expect(output).toMatch(/submission flow, \d+ steps/);
  }, 60_000);
});
