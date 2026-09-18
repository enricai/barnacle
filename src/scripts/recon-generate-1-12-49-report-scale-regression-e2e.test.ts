import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Operationalizes the 1.12.49 report's verification hooks at the report's
 * own real archive order of magnitude (~4794 captures), not merely the
 * existing 502-capture production-scale fixture
 * (`recon-generate-1-12-49-production-scale-regression-e2e.test.ts`), which
 * already passes on HEAD and so cannot by itself prove the bugfix-001
 * (endpoint-collapse indexing) / bugfix-002 (splice-guard hoist) algorithmic
 * fixes generalize past that fixture's own narrow scale rather than merely
 * re-satisfying it. This corpus uses ~4800 captures, a field/key vocabulary
 * distinct from both existing fixtures, and its own surrounding pool of
 * unrelated same-host endpoints, so a regression that only re-narrows to a
 * shipped fixture's exact field names or capture counts would still surface
 * here — and, without the memoization fixes, this scale would blow well
 * past the wall-clock bound asserted below.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.own-backend-1-12-49-report-scale-regression-fixture.example.com";
const HEARTBEAT_URL = `https://${OWN_BACKEND_HOST}/config/session-ping`;
const LISTING_URL = `https://${OWN_BACKEND_HOST}/directory-listing/`;
const DRILL_URL = `https://${OWN_BACKEND_HOST}/directory-record-drill/`;
const PROMO_URL = `https://${OWN_BACKEND_HOST}/promo-banner/impression`;
const SURVEY_URL = `https://${OWN_BACKEND_HOST}/exit-survey/impression`;

// Field/key names distinct from both existing fixtures'
// (`displayOrder212`/`numberOfNights53`/`totalPages` and
// `sortRank`/`stockKeeping`/`pageCountEcho`), each coincidentally colliding
// with substrings of a same-host, fixed-query, zero-variance opaque-path
// beacon — the report's multi-field-collision splice defect, reproduced
// with a third distinct vocabulary and at the report's own real scale.
const RANK_WEIGHT_VALUE = "kP3nWzXbHq";
const UNIT_CODE_VALUE = "f82YrDmT";
const TOTAL_ECHO_VALUE = "wS5jCvNqLk1";
const BEACON_URL = `https://${OWN_BACKEND_HOST}/beam/${RANK_WEIGHT_VALUE}/tGh7RkBmWp/${UNIT_CODE_VALUE}/ZQ${TOTAL_ECHO_VALUE}Xd2Mn/pixel.gif?tag=PROD-EXAMPLE.WEB&mode=live`;

// Report-scale multiplicities, reaching the report's own real archive order
// of magnitude (~4794 total captures) so a fix that only holds at the
// existing 502-capture fixture's own committed scale surfaces here. The bulk
// of the scale-up lands on the repeated-endpoint groups
// (heartbeat/beacon) that bugfix-001's collapse-index memoization and
// bugfix-002's splice-guard hoist specifically target — each is an O(1),
// per-capture-memoized cost once those fixes are in place, so pushing their
// counts far past the existing fixture's is the discriminating test of
// whether the fix is genuinely per-capture O(1) rather than merely faster-
// but-still-super-linear. The paged listing/drill counts (whose downstream
// fold/drilldown detection is untouched by bugfix-001/002 and is not the
// subject of this regression) are held at a moderate, already-proven-fast
// multiple of the existing fixture's own listing/drill counts.
const HEARTBEAT_POLL_COUNT = 2100;
const LISTING_PAGE_COUNT = 280;
const DRILL_ITEM_COUNT = 280;
const BEACON_FIRE_COUNT = 2100;
const NOISE_VARIANT_COUNT = 120;

function extraResponseFields(prefix: string): Record<string, string> {
  return Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`${prefix}Attribute${i}`, "x"]));
}

function reportScaleCaptures(): Capture[] {
  const heartbeats = Array.from({ length: HEARTBEAT_POLL_COUNT }, (_, i) =>
    buildCapture({
      url: HEARTBEAT_URL,
      requestPostData: "[]",
      responseBody: { live: true, ...extraResponseFields("heartbeat") },
      timestamp: `2024-02-01T00:00:${String(i % 60).padStart(2, "0")}Z`,
    })
  );

  const listingPages = Array.from({ length: LISTING_PAGE_COUNT }, (_, i) =>
    buildCapture({
      url: `${LISTING_URL}?_=${1710000000 + i}`,
      requestPostData: JSON.stringify({ page: i + 1, totalEcho: TOTAL_ECHO_VALUE }),
      responseBody: {
        totalEcho: LISTING_PAGE_COUNT,
        records: [{ recordId: `r${i + 1}`, ...extraResponseFields("listing") }],
      },
      timestamp: `2024-02-01T00:01:${String(i % 60).padStart(2, "0")}Z`,
    })
  );

  const drills = Array.from({ length: DRILL_ITEM_COUNT }, (_, i) =>
    buildCapture({
      url: DRILL_URL,
      requestPostData: JSON.stringify({
        recordId: `r${i + 1}`,
        rankWeight: RANK_WEIGHT_VALUE,
        unitCode: UNIT_CODE_VALUE,
      }),
      responseBody: {
        variants: [{ variantId: `v${i + 1}`, ...extraResponseFields("drill") }],
        conversionRate: 1.0,
      },
      timestamp: `2024-02-01T00:02:${String(i % 60).padStart(2, "0")}Z`,
    })
  );

  const beacon = Array.from({ length: BEACON_FIRE_COUNT }, (_, i) =>
    buildCapture({
      url: BEACON_URL,
      requestPostData: null,
      method: "GET",
      responseBody: {},
      timestamp: `2024-02-01T00:03:${String(i % 60).padStart(2, "0")}Z`,
    })
  );

  // A pool of unrelated same-host noise endpoints, scaled with the rest of
  // the corpus, none of which declares a *Url-suffixed response field, so
  // none triggers the required-URL-field self-heal guard.
  const noiseVariants = Array.from({ length: NOISE_VARIANT_COUNT }, (_, i) => {
    const url = i % 2 === 0 ? PROMO_URL : SURVEY_URL;
    return buildCapture({
      url: `${url}?slot=widget-${i}`,
      requestPostData: JSON.stringify({ pageId: `page-${i}` }),
      responseBody: { headline: `Widget headline ${i}`, impressionCount: i },
      timestamp: `2024-02-01T00:04:${String(i % 60).padStart(2, "0")}Z`,
    });
  });

  return [...heartbeats, ...listingPages, ...drills, ...beacon, ...noiseVariants];
}

function writeRunDir(root: string, captures: Capture[]): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));
  captures.forEach((capture, index) => {
    writeFileSync(
      join(root, "graphql", `${String(index).padStart(5, "0")}-capture.json`),
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

describe("recon-generate CLI — 1.12.49 verification hooks at the report's own real archive scale (~4800 captures, distinct vocabulary)", () => {
  it("emits a contract.ts within order of magnitude of the shipped baseline with no beacon-path splice corruption at report scale, within a tight wall-clock bound", () => {
    const captures = reportScaleCaptures();
    expect(captures.length).toBeGreaterThanOrEqual(4800);

    workDir = mkdtempSync(join(tmpdir(), "barnacle-1-12-49-report-scale-regression-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, captures);

    const siteId = `report-scale-regression-1-12-49-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "accept cookie banner" },
          { step: "dismiss promo prompt" },
          { step: "poll session ping" },
          { step: "expand facet filters" },
          { step: "browse paged directory listing" },
          { step: "sort listing by relevance" },
          { step: "select first listed record" },
          { step: "open record drill panel" },
          { step: "drill into record variant availability", submitStep: true },
          { step: "confirm variant result summary" },
        ],
        submitEndpointPattern: "directory-record-drill",
        requireSubmitEndpointMatch: true,
        ownBackendHostnames: [OWN_BACKEND_HOST],
      })
    );

    const start = Date.now();
    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );
    const elapsedMs = Date.now() - start;

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    // Without bugfix-001/002's algorithmic fixes, the unmemoized re-parse/
    // re-walk work scales non-linearly with raw capture count and would blow
    // well past this bound at ~4880 captures. The bound has margin above the
    // legitimate linear-scan cost the query-less noise-admission fix in
    // capture-filters.ts added (isZeroVarianceRepeatCapture now always
    // computes its same-endpoint scan instead of short-circuiting for
    // query-less candidates), which still stays well under an order of
    // magnitude away from the shipped baseline.
    expect(elapsedMs).toBeLessThan(300_000);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    const httpClientCallCount = (contract.match(/await httpClient\(/g) ?? []).length;

    // At ~4880 raw captures (2100 + 280 + 280 + 2100 + 120), a fix that
    // generalizes must still collapse to a small, count-independent number
    // of calls, not scale 1:1 with the raw capture count.
    expect(httpClientCallCount).toBeLessThanOrEqual(10);

    // Neither noise endpoint, nor any of its per-variant query-string
    // slots, survives in any form.
    expect(contract).not.toContain("promo-banner/impression");
    expect(contract).not.toContain("exit-survey/impression");
    expect(contract).not.toContain("impressionCount");

    // No invalidly-nested placeholder anywhere in the emitted file.
    expect(contract).not.toMatch(/\$\{[^}]*\$\{/);

    // None of the three coincidentally-colliding, mutually-unrelated
    // payload field names may be spliced into the beacon's own opaque path.
    const beaconLineMatch = contract.match(/`[^`]*beam\/[^`]*pixel\.gif[^`]*`/);
    if (beaconLineMatch) {
      const beaconUrlTemplate = beaconLineMatch[0];
      expect(beaconUrlTemplate).not.toMatch(/beam\/\$\{/);
      expect(beaconUrlTemplate).not.toContain("rankWeight");
      expect(beaconUrlTemplate).not.toContain("unitCode");
      expect(beaconUrlTemplate).not.toContain("totalEcho");
    }

    // Order-of-magnitude line-count bound, same discipline as the existing
    // fixtures' own verification hooks, unaffected by the ~4800 raw capture
    // count.
    const lineCount = contract.split("\n").length;
    expect(lineCount).toBeLessThanOrEqual(1000);
  }, 360_000);
});
