import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Composes the two independently-landed #382 fixes in a single flow: the
 * nested-request-field flattening that lets `isRedundantSameEndpointGroup`
 * recognize a pagination cursor buried inside a request body object (not a
 * top-level field), and the majority-based zero-variance beacon splice
 * guard. None of the existing 1.12.49 e2e fixtures nest their listing
 * group's pagination field, so none of them actually exercises the two
 * fixes together. This fixture uses a nested `{query:{paging:{cursor}}}`
 * shape and a fresh field-name vocabulary distinct from every other
 * fixture's, so it cannot pass by accidentally re-narrowing to an
 * already-fixture-shaped literal.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.nested-pagination-splice-guard-fixture.example.com";
const LISTING_URL = `https://${OWN_BACKEND_HOST}/catalog-entries/`;
const DETAIL_URL = `https://${OWN_BACKEND_HOST}/catalog-entry-detail/`;

// Fresh, mutually unrelated field values, distinct from the vocabulary used
// by the three existing 1.12.49 fixtures, each coincidentally colliding
// with a substring of the beacon's opaque path below.
const WIDGET_TAG_VALUE = "mQ7vRkD1";
const BATCH_LABEL_VALUE = "hT4wYpx9";
const BEACON_URL = `https://${OWN_BACKEND_HOST}/authenticator/${WIDGET_TAG_VALUE}/anchor-node/${BATCH_LABEL_VALUE}/responder.html?clientId=EXAMPLE.WEB&environment=PROD`;

const LISTING_PAGE_COUNT = 8;
const DETAIL_ITEM_COUNT = 6;
const BEACON_FIRE_COUNT = 12;

function extraResponseFields(prefix: string): Record<string, string> {
  return Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`${prefix}Field${i}`, "x"]));
}

function combinedFixtureCaptures(): Capture[] {
  const listing = Array.from({ length: LISTING_PAGE_COUNT }, (_, i) =>
    buildCapture({
      url: `${LISTING_URL}?_=${1700000000 + i}`,
      // The pagination cursor lives NESTED inside `query.paging`, not as a
      // top-level field — the #382 nested-flatten fix's own defect shape.
      requestPostData: JSON.stringify({ query: { paging: { cursor: i + 1 } } }),
      responseBody: {
        totalPages: LISTING_PAGE_COUNT,
        entries: [{ entryId: `e${i + 1}`, ...extraResponseFields("listing") }],
      },
      timestamp: `2024-01-01T00:00:${String(i).padStart(2, "0")}Z`,
    })
  );

  const details = Array.from({ length: DETAIL_ITEM_COUNT }, (_, i) =>
    buildCapture({
      url: DETAIL_URL,
      // `widgetTag` and `batchLabel` are two mutually unrelated fields
      // whose values coincidentally collide with substrings of the
      // beacon's opaque path below.
      requestPostData: JSON.stringify({
        entryId: `e${i + 1}`,
        widgetTag: WIDGET_TAG_VALUE,
        batchLabel: BATCH_LABEL_VALUE,
      }),
      responseBody: {
        units: [{ unitId: `u${i + 1}`, ...extraResponseFields("detail") }],
      },
      timestamp: `2024-01-01T00:01:${String(i).padStart(2, "0")}Z`,
    })
  );

  // Same-host, fixed-query, zero-variance opaque-path beacon whose path
  // segments coincidentally embed both unrelated payload field values at
  // once — the multi-field-collision splice-guard shape.
  const beacon = Array.from({ length: BEACON_FIRE_COUNT }, (_, i) =>
    buildCapture({
      url: BEACON_URL,
      requestPostData: null,
      method: "GET",
      responseBody: {},
      timestamp: `2024-01-01T00:02:${String(i).padStart(2, "0")}Z`,
    })
  );

  return [...listing, ...details, ...beacon];
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

describe("recon-generate CLI — nested pagination-field endpoint collapse composed with beacon splice guard", () => {
  it("collapses the nested-pagination listing group and leaves the beacon path unspliced", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-nested-pagination-splice-guard-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, combinedFixtureCaptures());

    const siteId = `nested-pagination-splice-guard-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "browse paged catalog listing" },
          { step: "select first listed entry" },
          { step: "open entry detail panel", submitStep: true },
          { step: "confirm detail result summary" },
        ],
        submitEndpointPattern: "catalog-entry-detail",
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

    // Raw capture count is 26 (8 listing pages + 6 detail calls + 12 beacon
    // fires). Both real endpoint groups must collapse to one call each,
    // plus the beacon — well under the shipped baseline's order of
    // magnitude, not one hardcoded call per raw capture.
    expect(httpClientCallCount).toBeLessThanOrEqual(6);

    // No invalidly-nested placeholder anywhere in the emitted file.
    expect(contract).not.toMatch(/\$\{[^}]*\$\{/);

    // Neither unrelated payload field name may be spliced into the
    // beacon's own opaque path, and the beacon must either render as an
    // exact literal or be excluded as noise entirely.
    const beaconLineMatch = contract.match(/`[^`]*authenticator\/[^`]*responder\.html[^`]*`/);
    if (beaconLineMatch) {
      const beaconUrlTemplate = beaconLineMatch[0];
      expect(beaconUrlTemplate).not.toMatch(/authenticator\/\$\{/);
      expect(beaconUrlTemplate).not.toContain("widgetTag");
      expect(beaconUrlTemplate).not.toContain("batchLabel");
    }
  }, 30_000);
});
