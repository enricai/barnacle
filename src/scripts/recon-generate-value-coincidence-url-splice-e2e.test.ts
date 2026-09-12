import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * The existing 10-step-flow fixture (recon-generate-ten-step-flow-verification-
 * hooks-tight-line-count-e2e.test.ts) passes even against the pre-fix tree
 * because its captures each vary in exactly one request field with
 * byte-identical bodies and a beacon that never fires at all — none of that
 * shape actually exercises bugfix-001/002/003. This fixture instead mirrors
 * the report's real archive shapes directly: a fixed-query beacon whose body
 * differs on every fire, a listing/drill group that each vary in TWO request
 * fields (a real cursor plus a dead nonce), and a beacon opaque path segment
 * whose digits coincidentally equal another capture's payload-field value.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.own-backend-value-coincidence-splice-fixture.example.com";
const LISTING_URL = `https://${OWN_BACKEND_HOST}/available-products/`;
const DRILL_URL = `https://${OWN_BACKEND_HOST}/available-sailings/`;
// The opaque path segment's digits ("77") coincidentally equal the listing's
// own `totalPages` value below — the report's own trigger condition for the
// value-coincidence-threading splice defect.
const BEACON_URL = `https://${OWN_BACKEND_HOST}/authenticator/wJbfQL-77-K0X/responder.html?clientId=TPR-EXAMPLE.WEB&environment=PROD`;

const LISTING_PAGE_COUNT = 8;
const DRILL_ITEM_COUNT = 6;
const BEACON_FIRE_COUNT = 14;
const TOTAL_PAGES_VALUE = 77;

function extraResponseFields(prefix: string): Record<string, string> {
  return Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`${prefix}Field${i}`, "x"]));
}

function valueCoincidenceFixtureCaptures(): Capture[] {
  // Listing: varies in TWO request fields per capture — the real paging
  // cursor (`page`) plus an unrelated dead nonce (`traceId`) — the shape
  // bugfix-002's isRedundantSameEndpointGroup must independently clear both
  // varying keys for, not just a single-key group.
  const listing = Array.from({ length: LISTING_PAGE_COUNT }, (_, i) =>
    buildCapture({
      url: `${LISTING_URL}?_=${1700000000 + i}`,
      requestPostData: JSON.stringify({ page: i + 1, traceId: `trace-${i}-${Math.random()}` }),
      responseBody: {
        totalPages: TOTAL_PAGES_VALUE,
        products: [{ productId: `p${i + 1}`, ...extraResponseFields("listing") }],
      },
      timestamp: `2024-01-01T00:01:${String(i).padStart(2, "0")}Z`,
    })
  );

  // Drill: same two-varying-field shape, keyed on a different real cursor
  // (`productId`) plus its own dead nonce (`sessionNonce`).
  const drills = Array.from({ length: DRILL_ITEM_COUNT }, (_, i) =>
    buildCapture({
      url: DRILL_URL,
      requestPostData: JSON.stringify({
        productId: `p${i + 1}`,
        sessionNonce: `nonce-${i}-${Math.random()}`,
      }),
      responseBody: {
        units: [{ unitId: `s${i + 1}`, ...extraResponseFields("drill") }],
        exchangeRate: 1.0,
      },
      timestamp: `2024-01-01T00:02:${String(i).padStart(2, "0")}Z`,
    })
  );

  // Beacon: same-host, fixed query, zero real request variance — but a
  // NON-IDENTICAL body every fire (an embedded per-call fingerprint), so it
  // can't be excluded via byte-identical-body matching alone. Its opaque
  // path segment's "77" digit run coincidentally equals the listing's own
  // `totalPages` value above.
  const beacon = Array.from({ length: BEACON_FIRE_COUNT }, (_, i) =>
    buildCapture({
      url: BEACON_URL,
      requestPostData: `fingerprint=beacon-${i}-${Math.random().toString(36).slice(2)}`,
      method: "POST",
      responseBody: {},
      timestamp: `2024-01-01T00:03:${String(i).padStart(2, "0")}Z`,
    })
  );

  return [...listing, ...drills, ...beacon];
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

describe("recon-generate CLI — value-coincidence splice guard against a faithful multi-field-variance fixture", () => {
  it("collapses multi-field-varying groups, excludes the varying-body beacon or leaves it unspliced, and lands near baseline order of magnitude", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-value-coincidence-splice-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, valueCoincidenceFixtureCaptures());

    const siteId = `value-coincidence-splice-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "browse paged product listing" },
          { step: "sort listing by relevance" },
          { step: "select first listed item" },
          { step: "open item detail panel" },
          { step: "drill into sailing availability", submitStep: true },
          { step: "confirm drill result summary" },
        ],
        submitEndpointPattern: "available-sailings",
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
    const httpClientCallCount = (contract.match(/await httpClient\(/g) ?? []).length;

    // Raw capture count is 28 (8 listing + 6 drills + 14 beacon fires). The
    // report's own required_item 1: order of magnitude ~4, not one
    // hardcoded call per raw capture, and specifically not one per varying
    // dead-field value within the listing/drill groups.
    expect(httpClientCallCount).toBeLessThanOrEqual(10);

    // The beacon's opaque path must never carry a spliced-in payload field
    // name, and no invalidly-nested placeholder may appear anywhere, whether
    // the beacon is excluded entirely or emitted as a literal call.
    expect(contract).not.toMatch(/authenticator\/responder\.html\$\{/);
    expect(contract).not.toMatch(/\$\{[^}]*\$\{/);
    expect(contract).not.toContain("totalPages}0");
    expect(contract).not.toMatch(/wJbfQL-\$\{[^}]*totalPages/);

    // The report's own line-count verification hook, order-of-magnitude: at
    // most ~1000 lines (baseline 569), nowhere near the un-collapsed
    // regression's thousands.
    const lineCount = contract.split("\n").length;
    expect(lineCount).toBeLessThanOrEqual(1000);
  }, 30_000);
});
