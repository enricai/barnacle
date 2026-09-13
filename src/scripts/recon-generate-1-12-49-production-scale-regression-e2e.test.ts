import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Operationalizes the 1.12.49 report's verification hooks at a scale and
 * variance shape close to the real archive rather than the existing narrow
 * fixture (`recon-generate-1-12-49-partial-fix-combined-verification-hooks-
 * e2e.test.ts`, which already passes on HEAD and so cannot by itself prove
 * the endpoint-collapse / noise-exclusion / url-splice-guard fixes
 * generalized rather than re-satisfying that fixture's own narrow shape).
 * This corpus uses ~500 captures, a field/key vocabulary distinct from the
 * existing fixture's, and a surrounding pool of unrelated same-host
 * endpoints, so a regression that only re-narrows to the shipped fixture's
 * exact field names or capture counts would still surface here.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.own-backend-1-12-49-production-scale-regression-fixture.example.com";
const HEARTBEAT_URL = `https://${OWN_BACKEND_HOST}/config/feature-heartbeat`;
const CATALOG_URL = `https://${OWN_BACKEND_HOST}/catalog-entries/`;
const DETAIL_URL = `https://${OWN_BACKEND_HOST}/catalog-entry-detail/`;
const NEWSLETTER_URL = `https://${OWN_BACKEND_HOST}/newsletter-widget/impression`;
const SURVEY_URL = `https://${OWN_BACKEND_HOST}/survey-widget/impression`;

// Field/key names distinct from the existing narrow fixture's
// (`displayOrder212`, `numberOfNights53`, `totalPages`), each coincidentally
// colliding with substrings of a same-host, fixed-query, zero-variance
// opaque-path beacon — the report's multi-field-collision splice defect,
// reproduced with a different vocabulary and at production scale.
const SORT_RANK_VALUE = "mQ4vZaWtRj";
const STOCK_KEEPING_VALUE = "b91XeLKp";
const PAGE_COUNT_ECHO_VALUE = "oT7hUrNqYd0";
const BEACON_URL = `https://${OWN_BACKEND_HOST}/relay/${SORT_RANK_VALUE}/nDs0FvKmZq/${STOCK_KEEPING_VALUE}/YR${PAGE_COUNT_ECHO_VALUE}Wc3Lp/pixel.gif?tag=PROD-EXAMPLE.WEB&mode=live`;

// Production-scale multiplicities — an order of magnitude above the
// existing narrow fixture (6/8/6/14) — so a fix that only holds at toy
// scale, or that only holds for the fixture's exact counts, surfaces here.
const HEARTBEAT_POLL_COUNT = 60;
const CATALOG_PAGE_COUNT = 180;
const DETAIL_ITEM_COUNT = 180;
const BEACON_FIRE_COUNT = 70;
const NOISE_VARIANT_COUNT = 12;

function extraResponseFields(prefix: string): Record<string, string> {
  return Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`${prefix}Attribute${i}`, "x"]));
}

function productionScaleCaptures(): Capture[] {
  const heartbeats = Array.from({ length: HEARTBEAT_POLL_COUNT }, (_, i) =>
    buildCapture({
      url: HEARTBEAT_URL,
      requestPostData: "[]",
      responseBody: { live: true, ...extraResponseFields("heartbeat") },
      timestamp: `2024-02-01T00:00:${String(i % 60).padStart(2, "0")}Z`,
    })
  );

  const catalogPages = Array.from({ length: CATALOG_PAGE_COUNT }, (_, i) =>
    buildCapture({
      url: `${CATALOG_URL}?_=${1710000000 + i}`,
      requestPostData: JSON.stringify({ page: i + 1, pageCountEcho: PAGE_COUNT_ECHO_VALUE }),
      responseBody: {
        pageCountEcho: CATALOG_PAGE_COUNT,
        entries: [{ entryId: `e${i + 1}`, ...extraResponseFields("catalog") }],
      },
      timestamp: `2024-02-01T00:01:${String(i % 60).padStart(2, "0")}Z`,
    })
  );

  const details = Array.from({ length: DETAIL_ITEM_COUNT }, (_, i) =>
    buildCapture({
      url: DETAIL_URL,
      requestPostData: JSON.stringify({
        entryId: `e${i + 1}`,
        sortRank: SORT_RANK_VALUE,
        stockKeeping: STOCK_KEEPING_VALUE,
      }),
      responseBody: {
        variants: [{ variantId: `v${i + 1}`, ...extraResponseFields("detail") }],
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

  // A pool of unrelated same-host noise endpoints — larger and more varied
  // than the existing fixture's single two-variant pair — none of which
  // declares a *Url-suffixed response field, so none triggers the
  // required-URL-field self-heal guard.
  const noiseVariants = Array.from({ length: NOISE_VARIANT_COUNT }, (_, i) => {
    const url = i % 2 === 0 ? NEWSLETTER_URL : SURVEY_URL;
    return buildCapture({
      url: `${url}?slot=widget-${i}`,
      requestPostData: JSON.stringify({ pageId: `page-${i}` }),
      responseBody: { headline: `Widget headline ${i}`, impressionCount: i },
      timestamp: `2024-02-01T00:04:${String(i % 60).padStart(2, "0")}Z`,
    });
  });

  return [...heartbeats, ...catalogPages, ...details, ...beacon, ...noiseVariants];
}

function writeRunDir(root: string, captures: Capture[]): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));
  captures.forEach((capture, index) => {
    writeFileSync(
      join(root, "graphql", `${String(index).padStart(4, "0")}-capture.json`),
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

describe("recon-generate CLI — 1.12.49 verification hooks at production scale (500+ captures, distinct vocabulary, larger noise pool)", () => {
  it("emits a contract.ts within order of magnitude of the shipped baseline with no beacon-path splice corruption at production scale", () => {
    const captures = productionScaleCaptures();
    expect(captures.length).toBeGreaterThanOrEqual(500);

    workDir = mkdtempSync(join(tmpdir(), "barnacle-1-12-49-production-scale-regression-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, captures);

    const siteId = `production-scale-regression-1-12-49-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "accept cookie banner" },
          { step: "dismiss newsletter prompt" },
          { step: "poll feature heartbeat" },
          { step: "expand facet filters" },
          { step: "browse paged catalog listing" },
          { step: "sort listing by relevance" },
          { step: "select first listed entry" },
          { step: "open entry detail panel" },
          { step: "drill into entry variant availability", submitStep: true },
          { step: "confirm variant result summary" },
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

    // Shipped baseline is 4 calls for 569 lines. At 502 raw captures
    // (60 + 180 + 180 + 70 + 12), a fix that generalizes must still collapse
    // to a small, count-independent number of calls, not scale 1:1 with the
    // raw capture count.
    expect(httpClientCallCount).toBeLessThanOrEqual(10);

    // Neither noise endpoint, nor any of its per-variant query-string
    // slots, survives in any form.
    expect(contract).not.toContain("newsletter-widget/impression");
    expect(contract).not.toContain("survey-widget/impression");
    expect(contract).not.toContain("impressionCount");

    // No invalidly-nested placeholder anywhere in the emitted file.
    expect(contract).not.toMatch(/\$\{[^}]*\$\{/);

    // None of the three coincidentally-colliding, mutually-unrelated
    // payload field names may be spliced into the beacon's own opaque path.
    const beaconLineMatch = contract.match(/`[^`]*relay\/[^`]*pixel\.gif[^`]*`/);
    if (beaconLineMatch) {
      const beaconUrlTemplate = beaconLineMatch[0];
      expect(beaconUrlTemplate).not.toMatch(/relay\/\$\{/);
      expect(beaconUrlTemplate).not.toContain("sortRank");
      expect(beaconUrlTemplate).not.toContain("stockKeeping");
      expect(beaconUrlTemplate).not.toContain("pageCountEcho");
    }

    // Order-of-magnitude line-count bound, same as the shipped baseline's
    // own verification hook, unaffected by the 500+ raw capture count.
    const lineCount = contract.split("\n").length;
    expect(lineCount).toBeLessThanOrEqual(1000);
  }, 60_000);
});
