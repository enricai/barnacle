import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Reproduces the value-coincidence-threading splice defect with a field
 * vocabulary independent of the report's own `displayOrder212` /
 * `numberOfNights53` / `totalPages` triple (already covered by
 * recon-generate-1-12-49-partial-fix-combined-verification-hooks-e2e.test.ts),
 * to guard that the fix generalizes beyond that exact vocabulary rather than
 * pattern-matching on it. Mirrors that sibling's structural shape (10-step
 * flow, toggles poll, listing/drill groups, a fixed-query zero-request-
 * variance opaque-path beacon, same-host marketing noise) since the beacon
 * only survives noise exclusion in that shape; this test only asserts the
 * splice-guard condition, independent of the noise-exclusion/endpoint-
 * collapse assertions already covered elsewhere.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST =
  "www.own-backend-value-coincidence-splice-unrelated-vocabulary-fixture.example.com";
const TOGGLES_URL = `https://${OWN_BACKEND_HOST}/toggles/product-avail`;
const LISTING_URL = `https://${OWN_BACKEND_HOST}/available-products/`;
const DRILL_URL = `https://${OWN_BACKEND_HOST}/available-sailings/`;
const PROMOTIONS_URL = `https://${OWN_BACKEND_HOST}/promotions-spa/banner`;

// Three unrelated payload field values, none sharing a name with the
// report's own vocabulary, each independently threaded into the beacon's
// opaque path below.
const SORT_WEIGHT_VALUE = "gTmXqZ-P9v";
const CABIN_CLASS_CODE_VALUE = "wZq44Lk2";
const LOYALTY_TIER_VALUE = "hUeNc7rBmXo";
const BEACON_URL = `https://${OWN_BACKEND_HOST}/authenticator/${SORT_WEIGHT_VALUE}/QGFBhqav0s/${CABIN_CLASS_CODE_VALUE}/WC${LOYALTY_TIER_VALUE}Rd6QI/responder.html?clientId=TPR-EXAMPLE.WEB&environment=PROD`;

const TOGGLES_POLL_COUNT = 6;
const LISTING_PAGE_COUNT = 8;
const DRILL_ITEM_COUNT = 6;
const BEACON_FIRE_COUNT = 14;

function extraResponseFields(prefix: string): Record<string, string> {
  return Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`${prefix}Field${i}`, "x"]));
}

function valueCoincidenceUnrelatedVocabularyFixtureCaptures(): Capture[] {
  const toggles = Array.from({ length: TOGGLES_POLL_COUNT }, (_, i) =>
    buildCapture({
      url: TOGGLES_URL,
      requestPostData: "[]",
      responseBody: { enabled: true, ...extraResponseFields("toggle") },
      timestamp: `2024-01-01T00:00:${String(i).padStart(2, "0")}Z`,
    })
  );

  const listing = Array.from({ length: LISTING_PAGE_COUNT }, (_, i) =>
    buildCapture({
      url: `${LISTING_URL}?_=${1700000000 + i}`,
      // `sortWeight` is an unrelated listing-ordering field whose value
      // coincidentally collides with a substring of the beacon path below.
      requestPostData: JSON.stringify({ page: i + 1, sortWeight: SORT_WEIGHT_VALUE }),
      responseBody: {
        totalPages: LISTING_PAGE_COUNT,
        products: [{ productId: `p${i + 1}`, ...extraResponseFields("listing") }],
      },
      timestamp: `2024-01-01T00:01:${String(i).padStart(2, "0")}Z`,
    })
  );

  const drills = Array.from({ length: DRILL_ITEM_COUNT }, (_, i) =>
    buildCapture({
      url: DRILL_URL,
      // `cabinClassCode` and `loyaltyTier` are two more unrelated fields
      // whose values each coincidentally collide with beacon-path substrings.
      requestPostData: JSON.stringify({
        productId: `p${i + 1}`,
        cabinClassCode: CABIN_CLASS_CODE_VALUE,
        loyaltyTier: LOYALTY_TIER_VALUE,
      }),
      responseBody: {
        units: [{ unitId: `s${i + 1}`, ...extraResponseFields("drill") }],
        exchangeRate: 1.0,
      },
      timestamp: `2024-01-01T00:02:${String(i).padStart(2, "0")}Z`,
    })
  );

  const beacon = Array.from({ length: BEACON_FIRE_COUNT }, (_, i) =>
    buildCapture({
      url: BEACON_URL,
      requestPostData: null,
      method: "GET",
      responseBody: {},
      timestamp: `2024-01-01T00:03:${String(i).padStart(2, "0")}Z`,
    })
  );

  const noiseVariantOne = buildCapture({
    url: `${PROMOTIONS_URL}?slot=footer`,
    requestPostData: '{"pageId":"listings"}',
    responseBody: { headline: "Limited-time offer", impressionCount: 1 },
    timestamp: "2024-01-01T00:04:00Z",
  });
  const noiseVariantTwo = buildCapture({
    url: `${PROMOTIONS_URL}/2?slot=header`,
    requestPostData: '{"pageId":"home"}',
    responseBody: { headline: "Seasonal deal", impressionCount: 7 },
    timestamp: "2024-01-01T00:04:01Z",
  });

  return [...toggles, ...listing, ...drills, ...beacon, noiseVariantOne, noiseVariantTwo];
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

describe("recon-generate CLI — value-coincidence splice guard with an unrelated field vocabulary", () => {
  it("never splices unrelated payload field names into the beacon's opaque path and never emits an invalidly-nested placeholder", () => {
    workDir = mkdtempSync(
      join(tmpdir(), "barnacle-value-coincidence-splice-unrelated-vocabulary-e2e-")
    );
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, valueCoincidenceUnrelatedVocabularyFixtureCaptures());

    const siteId = `value-coincidence-splice-unrelated-vocabulary-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "accept cookie banner" },
          { step: "dismiss newsletter prompt" },
          { step: "poll feature toggles" },
          { step: "expand facet filters" },
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

    // No invalidly-nested placeholder anywhere in the emitted file.
    expect(contract).not.toMatch(/\$\{[^}]*\$\{/);

    // None of the three unrelated payload field names may be spliced into
    // the beacon's own URL template, whether the beacon survives collapse
    // as a literal call or an interpolated one.
    const beaconLineMatch = contract.match(/`[^`]*authenticator\/[^`]*responder\.html[^`]*`/);
    if (beaconLineMatch) {
      const beaconUrlTemplate = beaconLineMatch[0];
      expect(beaconUrlTemplate).not.toMatch(/authenticator\/\$\{/);
      expect(beaconUrlTemplate).not.toContain("sortWeight");
      expect(beaconUrlTemplate).not.toContain("cabinClassCode");
      expect(beaconUrlTemplate).not.toContain("loyaltyTier");
    }
  }, 30_000);
});
