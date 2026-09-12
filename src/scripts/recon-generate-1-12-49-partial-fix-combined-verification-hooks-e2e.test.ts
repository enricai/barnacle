import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Operationalizes the 1.12.49 partial-fix report's own "Verification hooks"
 * section as one combined acceptance check: a 10-declared-step flow whose
 * real-endpoint groups repeat at the report's own multiplicities (8 listing /
 * 6 drill / 6 poll), plus its newly-found same-host, fixed-query,
 * zero-variance opaque-path beacon (fired 14x), plus same-host marketing
 * noise. Unlike `recon-generate-partial-fix-verification-hooks-combined-
 * e2e.test.ts` (which reproduces the PRIOR #372 report with a single
 * deliberately-engineered exact-substring match in the beacon path), this
 * fixture reproduces THIS report's own defect shape: three independently
 * unrelated payload fields (`displayOrder212`, `numberOfNights53`,
 * `totalPages`) whose VALUES each coincidentally collide with substrings of
 * the beacon's opaque path, tempting `payloadAccessorByValue` to splice all
 * three in as separate, nested placeholders rather than the single-match
 * case the older fixture already covers.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.own-backend-1-12-49-combined-verification-hooks-fixture.example.com";
const TOGGLES_URL = `https://${OWN_BACKEND_HOST}/toggles/product-avail`;
const LISTING_URL = `https://${OWN_BACKEND_HOST}/available-products/`;
const DRILL_URL = `https://${OWN_BACKEND_HOST}/available-sailings/`;
const PROMOTIONS_URL = `https://${OWN_BACKEND_HOST}/promotions-spa/banner`;

// The report's own three coincidentally-colliding, mutually-unrelated
// payload field values, each independently threaded into the beacon's
// opaque path — the report's own multi-field-collision shape, not a single
// engineered substring match.
const DISPLAY_ORDER_VALUE = "wJbfQL-K0X";
const NUMBER_OF_NIGHTS_VALUE = "zIkbzN11";
const TOTAL_PAGES_VALUE = "cpOiDWntmAQ";
const BEACON_URL = `https://${OWN_BACKEND_HOST}/authenticator/${DISPLAY_ORDER_VALUE}/QGFBhqav0s/${NUMBER_OF_NIGHTS_VALUE}/WC${TOTAL_PAGES_VALUE}Rd6QI/responder.html?clientId=TPR-EXAMPLE.WEB&environment=PROD`;

// The report's own reference multiplicities (8/6/6/14).
const TOGGLES_POLL_COUNT = 6;
const LISTING_PAGE_COUNT = 8;
const DRILL_ITEM_COUNT = 6;
const BEACON_FIRE_COUNT = 14;

// Same rationale as recon-generate-ten-step-flow-verification-hooks-tight-
// line-count-e2e.test.ts: a minimal toy fixture can't reach the report's
// own ~500-900 line bound without a realistic-sized field vocabulary.
function extraResponseFields(prefix: string): Record<string, string> {
  return Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`${prefix}Field${i}`, "x"]));
}

function combinedFixtureCaptures(): Capture[] {
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
      // `totalPages` is the plugin's own pagination-total field — the
      // report's own account of one of the three colliding values.
      requestPostData: JSON.stringify({ page: i + 1, totalPages: TOTAL_PAGES_VALUE }),
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
      // `displayOrder212` (stateroom ordering) and `numberOfNights53`
      // (sailing night count) are the report's own two other unrelated
      // fields whose values coincidentally collide with substrings of the
      // beacon's opaque path below.
      requestPostData: JSON.stringify({
        productId: `p${i + 1}`,
        displayOrder212: DISPLAY_ORDER_VALUE,
        numberOfNights53: NUMBER_OF_NIGHTS_VALUE,
      }),
      responseBody: {
        units: [{ unitId: `s${i + 1}`, ...extraResponseFields("drill") }],
        exchangeRate: 1.0,
      },
      timestamp: `2024-01-01T00:02:${String(i).padStart(2, "0")}Z`,
    })
  );

  // The report's newly-found defect: a same-host, fixed-query, zero-
  // variance opaque-path beacon (an authenticator/analytics-style capture
  // with base64-like path segments) whose segments coincidentally embed
  // three UNRELATED payload field values at once — the multi-field
  // collision shape, not a single deliberately-engineered match.
  const beacon = Array.from({ length: BEACON_FIRE_COUNT }, (_, i) =>
    buildCapture({
      url: BEACON_URL,
      requestPostData: null,
      method: "GET",
      responseBody: {},
      timestamp: `2024-01-01T00:03:${String(i).padStart(2, "0")}Z`,
    })
  );

  // The two-stage same-host marketing-style noise-family pair: no
  // *Url-suffixed response field, so it never triggers the required-URL-
  // field self-heal guard.
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

describe("recon-generate CLI — 1.12.49 partial-fix combined verification hooks (report multiplicities, multi-field-collision beacon splice guard, noise exclusion, order-of-magnitude bound)", () => {
  it("emits a contract.ts in the shipped baseline's order of magnitude with no multi-field-collision beacon-path splice corruption", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-1-12-49-combined-verification-hooks-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, combinedFixtureCaptures());

    const siteId = `combined-verification-hooks-1-12-49-e2e-test-${process.pid}`;
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
    const httpClientCallCount = (contract.match(/await httpClient\(/g) ?? []).length;

    // Raw capture count is 36 (6 toggles + 8 listing pages + 6 drills + 14
    // beacon fires + 2 noise variants). The report's own verification hook:
    // order of magnitude ~4, not one hardcoded call per raw capture (the
    // reported regression emitted 38 for 7880 lines).
    expect(httpClientCallCount).toBeLessThanOrEqual(10);

    // Neither marketing noise-family path/query variant survives, in any
    // form.
    expect(contract).not.toContain("promotions-spa/banner");
    expect(contract).not.toContain("impressionCount");

    // No invalidly-nested placeholder anywhere in the emitted file — the
    // report's own description of the corrupted output
    // (`${displayOrder${displayOrder212}11}`).
    expect(contract).not.toMatch(/\$\{[^}]*\$\{/);

    // None of the three coincidentally-colliding, mutually-unrelated
    // payload field names may be spliced into the beacon's own opaque path
    // — the report's core new-defect verification hook, reproduced with its
    // own multi-field-collision shape rather than a single exact-substring
    // match.
    const beaconLineMatch = contract.match(/`[^`]*authenticator\/[^`]*responder\.html[^`]*`/);
    if (beaconLineMatch) {
      const beaconUrlTemplate = beaconLineMatch[0];
      expect(beaconUrlTemplate).not.toMatch(/authenticator\/\$\{/);
      expect(beaconUrlTemplate).not.toContain("displayOrder212");
      expect(beaconUrlTemplate).not.toContain("numberOfNights53");
      expect(beaconUrlTemplate).not.toContain("totalPages");
    }

    // The report's own line-count verification hook, order-of-magnitude:
    // at most ~1000 lines (baseline 569), nowhere near the reported 7880.
    const lineCount = contract.split("\n").length;
    expect(lineCount).toBeLessThanOrEqual(1000);
  }, 30_000);
});
