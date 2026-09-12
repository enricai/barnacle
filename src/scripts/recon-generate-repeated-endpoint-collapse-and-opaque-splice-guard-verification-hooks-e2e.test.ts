import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Combines the three landed fixes' own trigger shapes into one fixture, so
 * the acceptance check is that they hold TOGETHER rather than in isolation:
 * a real listing endpoint repeated many times whose sole varying key is a
 * non-allowlisted, chained cursor name (pagination-shape collapse); a
 * mutation-method (POST) endpoint repeated many times with a byte-identical
 * response (mutation-method collapse); and a same-host, fixed-query,
 * opaque-path beacon interleaved among an unrelated login/confirm exchange
 * that mints a short, genuinely-threaded state value whose digits
 * coincidentally appear in the beacon's own path (zero-variance noise
 * exclusion plus chain-scoped splice guard).
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.own-backend-collapse-and-splice-guard-fixture.example.com";
const LOGIN_URL = `https://${OWN_BACKEND_HOST}/auth/login`;
const CONFIRM_URL = `https://${OWN_BACKEND_HOST}/auth/confirm`;
const TOGGLE_URL = `https://${OWN_BACKEND_HOST}/toggles/inventory-avail`;
const LISTING_URL = `https://${OWN_BACKEND_HOST}/inventory-listing/`;
// A same-host, fixed-query, opaque-path beacon whose path digits ("58")
// coincidentally equal the login/confirm exchange's short authToken below.
const BEACON_URL = `https://${OWN_BACKEND_HOST}/session-beacon/wJbfQL-58-K0X/ping?clientId=TPR-EXAMPLE.WEB&environment=PROD`;

const TOGGLE_POLL_COUNT = 6;
const LISTING_PAGE_COUNT = 8;
const BEACON_FIRE_COUNT = 14;
const AUTH_TOKEN_VALUE = "58";

function extraResponseFields(prefix: string): Record<string, string> {
  return Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`${prefix}Field${i}`, "x"]));
}

function combinedFixtureCaptures(): Capture[] {
  const login = buildCapture({
    method: "POST",
    url: LOGIN_URL,
    requestPostData: '{"user":"alice"}',
    responseBody: { authToken: AUTH_TOKEN_VALUE, ack: true },
    timestamp: "2024-01-01T00:00:00Z",
  });

  const confirm = buildCapture({
    method: "POST",
    url: CONFIRM_URL,
    requestPostData: null,
    requestHeaders: { "Content-Type": "application/json", "X-Auth-Token": AUTH_TOKEN_VALUE },
    responseBody: { confirmed: true },
    timestamp: "2024-01-01T00:00:01Z",
  });

  // Mutation-method (POST) endpoint fired repeatedly with a byte-identical
  // response every time — must collapse to one call, not N.
  const toggles = Array.from({ length: TOGGLE_POLL_COUNT }, (_, i) =>
    buildCapture({
      method: "POST",
      url: TOGGLE_URL,
      requestPostData: "[]",
      responseBody: { enabled: true, ...extraResponseFields("toggle") },
      timestamp: `2024-01-01T00:01:${String(i).padStart(2, "0")}Z`,
    })
  );

  // Real listing endpoint repeated many times whose ONLY varying key is a
  // non-allowlisted cursor name that each response hands forward to the
  // next request — the pagination-shape fix's own trigger condition.
  const cursors = Array.from({ length: LISTING_PAGE_COUNT }, (_, i) => `seg-${i}`);
  const listing = cursors.map((cursor, i) =>
    buildCapture({
      url: LISTING_URL,
      requestPostData: JSON.stringify({ resultsToken: cursor }),
      responseBody: {
        items: [{ itemId: `item-${i}`, ...extraResponseFields("listing") }],
        nextResultsToken: cursors[i + 1] ?? null,
      },
      timestamp: `2024-01-01T00:02:${String(i).padStart(2, "0")}Z`,
    })
  );

  // Same-host, fixed-query, opaque-path beacon interleaved among the other
  // steps. Its request body varies per fire (so byte-identical-body matching
  // alone can't exclude it) but its response only echoes back the fixed
  // `clientId` query param — no business-relevant state of its own — and its
  // opaque path coincidentally carries the login/confirm exchange's own
  // short authToken digits.
  const beacon = Array.from({ length: BEACON_FIRE_COUNT }, (_, i) =>
    buildCapture({
      method: "POST",
      url: BEACON_URL,
      requestPostData: `fingerprint=beacon-${i}-${Math.random().toString(36).slice(2)}`,
      responseBody: { clientId: "TPR-EXAMPLE.WEB" },
      timestamp: `2024-01-01T00:03:${String(i).padStart(2, "0")}Z`,
    })
  );

  return [login, confirm, ...toggles, ...listing, ...beacon];
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

describe("recon-generate CLI — repeated-endpoint collapse and opaque-path splice guard, combined", () => {
  it("collapses every repeated group to one call each and never splices a state value into the beacon's own path", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-collapse-and-splice-guard-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, combinedFixtureCaptures());

    const siteId = `collapse-and-splice-guard-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "log in" },
          { step: "confirm session" },
          { step: "poll feature toggles" },
          { step: "browse paged inventory listing" },
          { step: "sort listing by relevance" },
          { step: "select first listed item" },
          { step: "open item detail panel" },
          { step: "drill into item availability", submitStep: true },
        ],
        submitEndpointPattern: "inventory-listing",
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

    // Each repeated same-endpoint group collapses to exactly one call, down
    // from its raw fire count (6 toggles, 8 listing pages).
    const toggleCallCount = (contract.match(/toggles\/inventory-avail/g) ?? []).length;
    const listingCallCount = (contract.match(/inventory-listing\//g) ?? []).length;
    expect(toggleCallCount).toBe(1);
    expect(listingCallCount).toBe(1);

    // The beacon's opaque path never carries a spliced-in state-value
    // reference, whether it survives as a literal call or is excluded as
    // noise entirely — the report's core new-defect verification hook.
    expect(contract).not.toMatch(/session-beacon\/wJbfQL-\$\{/);
    expect(contract).not.toMatch(/\$\{[^}]*\$\{/);

    // The beacon appears at most once (either excluded, or emitted as a
    // single literal call), never once per raw fire.
    const beaconCallCount = (contract.match(/session-beacon\//g) ?? []).length;
    expect(beaconCallCount).toBeLessThanOrEqual(1);

    // Overall call count is in the collapsed order of magnitude, not one
    // hardcoded call per raw capture (34 raw captures: login + confirm + 6
    // toggles + 8 listing pages + 14 beacon fires).
    const httpClientCallCount = (contract.match(/await httpClient\(/g) ?? []).length;
    expect(httpClientCallCount).toBeLessThanOrEqual(8);
  }, 30_000);
});
