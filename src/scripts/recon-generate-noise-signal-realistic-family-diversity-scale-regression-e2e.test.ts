import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Reproduces the reported noise-widget regression at a diversity level
 * closer to the reported live site's actual capture composition: the
 * existing recon-generate-noise-signal-*-regression-e2e.test.ts files each
 * pit the 7x noise widget against only the two real endpoints (search +
 * drill) required by the flow's submit step. This adds ~24 distinct real
 * endpoint families — the shape a real recon capture set has once every
 * page, widget, and API call on a live site is counted — to prove fold-plan
 * primary-operation selection and noise exclusion both still hold at scale,
 * not just in the two-endpoint minimal case.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

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

function runGenerate(siteId: string, runRoot: string): ReturnType<typeof spawnSync> {
  return spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon noise admission at realistic endpoint-family diversity: ~24 distinct real endpoints plus a 7x fixed-response noise widget", () => {
  it("emits every real endpoint family and never the noise endpoint when recon-generate --force runs against a realistic capture mix", () => {
    const OWN_BACKEND_HOST = "www.noise-realistic-diversity-fixture.example.com";
    const SEARCH_URL = `https://${OWN_BACKEND_HOST}/catalog-search/`;
    const DRILL_URL = `https://${OWN_BACKEND_HOST}/catalog-detail/`;
    const SAME_ORIGIN_NOISE_URL = `https://${OWN_BACKEND_HOST}/pulse/api/v1/urgency`;

    workDir = mkdtempSync(join(tmpdir(), "barnacle-noise-realistic-diversity-"));
    const runRoot = join(workDir, "run");

    let secondsCursor = 0;
    const nextTimestamp = (): string => {
      const minute = Math.floor(secondsCursor / 60);
      const second = secondsCursor % 60;
      secondsCursor++;
      return `2026-01-01T00:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}Z`;
    };

    const search = buildCapture({
      url: SEARCH_URL,
      requestPostData: JSON.stringify({ q: "widgets" }),
      responseBody: { results: [{ id: "item-1" }, { id: "item-2" }] },
      timestamp: nextTimestamp(),
    });

    // ~24 distinct real endpoint families sharing the flow's own
    // `catalog-` namespace — the density of sub-resource endpoints a live
    // product page actually fires (reviews, pricing, availability, media,
    // ...), all structurally related to the declared search/drill pair via
    // {@link isStructurallyRelevantCapture}'s shared-token rule (the same
    // rule that admits `catalog-search/` alongside the `catalog-detail/`
    // submit anchor) so recon-generate's structural-relevance narrowing
    // pass — not just its noise exclusion — is exercised at realistic
    // scale rather than the two-endpoint minimal case the sibling
    // regression files pin.
    const familyNames = [
      "catalog-reviews",
      "catalog-pricing",
      "catalog-promotions",
      "catalog-recommendations",
      "catalog-inventory",
      "catalog-availability",
      "catalog-images",
      "catalog-variants",
      "catalog-bundles",
      "catalog-warranty",
      "catalog-shipping-estimate",
      "catalog-tax-estimate",
      "catalog-loyalty",
      "catalog-gift-wrap",
      "catalog-substitutes",
      "catalog-comparisons",
      "catalog-specs",
      "catalog-faq",
      "catalog-video",
      "catalog-ratings-summary",
      "catalog-stock-alerts",
      "catalog-price-history",
      "catalog-related-searches",
      "catalog-trending",
    ];
    expect(familyNames).toHaveLength(24);

    const realFamilyCaptures: Capture[] = familyNames.map((family) =>
      buildCapture({
        url: `https://${OWN_BACKEND_HOST}/${family}/`,
        requestPostData: JSON.stringify({ family }),
        responseBody: { family, payload: { ok: true, family } },
        timestamp: nextTimestamp(),
      })
    );

    // The drill/submit capture must be the chronologically LAST occurrence
    // of the declared submitEndpointPattern: recon-generate truncates the
    // heuristic action sequence at the last submit-pattern match
    // (`truncateActionSequenceAtSubmitPattern`), so any real endpoint fired
    // after it would be dropped regardless of how structurally related it
    // is — the same reason a real site's own page-chrome/widget calls that
    // fire after the submit action never end up in the contract either.
    const drill = buildCapture({
      url: DRILL_URL,
      requestPostData: JSON.stringify({ id: "item-1" }),
      responseBody: { detail: { id: "item-1", price: 42 } },
      timestamp: nextTimestamp(),
    });

    // 7 same-origin widget noise captures — the exact occurrence count from
    // the reported live-site repro, carrying the SAME fixed business-looking
    // (non-URL-derivable) body every time so admission depends on
    // structural isolation rather than occurrence count alone.
    const sameOriginNoise: Capture[] = Array.from({ length: 7 }, () =>
      buildCapture({
        url: SAME_ORIGIN_NOISE_URL,
        requestPostData: null,
        responseBody: { urgencyLevel: "high" },
        timestamp: nextTimestamp(),
      })
    );

    const allCaptures = [search, ...realFamilyCaptures, drill, ...sameOriginNoise];
    expect(allCaptures).toHaveLength(2 + 24 + 7);

    writeRunDir(runRoot, allCaptures);

    const siteId = `noise-realistic-diversity-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "search catalog" }, { step: "view item detail", submitStep: true }],
        submitEndpointPattern: "catalog-detail",
        requireSubmitEndpointMatch: true,
        ownBackendHostnames: [OWN_BACKEND_HOST],
      })
    );

    const result = runGenerate(siteId, runRoot);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    expect(contract).toContain("catalog-search/");
    expect(contract).toContain("catalog-detail/");
    familyNames.forEach((family) => {
      expect(contract).toContain(`${family}/`);
    });
    expect(contract).not.toContain("pulse/api/v1/urgency");
  });
});
