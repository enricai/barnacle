import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Item 0's exact reported regression, at reported scale: 46 mixed-family
 * noise captures (third-party ad-tech/telemetry hosts matched by
 * `isNoiseUrl`, plus a repeating same-origin fixed-shape widget) crowding
 * out 2 real captures (a search step and a drill step) — a 2-real-vs-48-total
 * ratio. Existing coverage only proves the queryless-repeat predicate in
 * isolation and a 12x homogeneous same-origin noise family through the
 * generator; neither proves a *mixed* third-party + same-origin noise family
 * at production scale still loses fold-plan primary selection to the real
 * endpoints once run through the full `recon-generate.ts` pipeline.
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

describe("recon noise admission at production scale: mixed third-party + same-origin noise family", () => {
  it("emits the real search/drill endpoints and never the noise endpoints when 46 mixed-family noise captures outnumber 2 real captures 23:1", () => {
    const OWN_BACKEND_HOST = "www.noise-scale-fixture.example.com";
    const SEARCH_URL = `https://${OWN_BACKEND_HOST}/catalog-search/`;
    const DRILL_URL = `https://${OWN_BACKEND_HOST}/catalog-detail/`;

    // Third-party asset/telemetry hosts already matched by `isNoiseUrl`
    // (src/recon/capture-filters.ts THIRD_PARTY_ASSET_HOSTS) — the exact
    // ad-tech/session-replay/tag-manager family the reported regression
    // named.
    const THIRD_PARTY_NOISE_URLS = [
      "https://sync.adsrvr.org/beacon?id=1",
      "https://www.googletagmanager.com/gtm.js?id=GTM-XXXX",
      "https://stats.g.doubleclick.net/pixel",
      "https://connect.facebook.net/en_US/fbevents.js",
      "https://static.hotjar.com/c/hotjar.js",
    ];
    // Same-origin, queryless, fixed-shape widget noise — the other half of
    // the reported family, repeating far more often than the real primary
    // and carrying no business-relevant response state.
    const SAME_ORIGIN_NOISE_URL = `https://${OWN_BACKEND_HOST}/pulse/urgency-widget`;

    workDir = mkdtempSync(join(tmpdir(), "barnacle-noise-scale-"));
    const runRoot = join(workDir, "run");

    const search = buildCapture({
      url: SEARCH_URL,
      requestPostData: JSON.stringify({ q: "widgets" }),
      responseBody: { results: [{ id: "item-1" }, { id: "item-2" }] },
      timestamp: "2026-01-01T00:00:00Z",
    });
    const drill = buildCapture({
      url: DRILL_URL,
      requestPostData: JSON.stringify({ id: "item-1" }),
      responseBody: { detail: { id: "item-1", price: 42 } },
      timestamp: "2026-01-01T00:00:01Z",
    });

    let secondsCursor = 2;
    const nextTimestamp = (): string =>
      `2026-01-01T00:00:${String(secondsCursor++).padStart(2, "0")}Z`;

    // 23 third-party noise captures (cycling through the 5 hosts above).
    const thirdPartyNoise: Capture[] = Array.from({ length: 23 }, (_, i) =>
      buildCapture({
        url: THIRD_PARTY_NOISE_URLS[i % THIRD_PARTY_NOISE_URLS.length]!,
        requestPostData: null,
        responseBody: { ok: true },
        timestamp: nextTimestamp(),
      })
    );
    // 23 same-origin widget noise captures — production-scale repeat count,
    // well above MIN_QUERYLESS_REPEAT_COUNT.
    const sameOriginNoise: Capture[] = Array.from({ length: 23 }, () =>
      buildCapture({
        url: SAME_ORIGIN_NOISE_URL,
        requestPostData: null,
        responseBody: {},
        timestamp: nextTimestamp(),
      })
    );

    // 2 real captures vs 46 mixed-family noise captures — the reported
    // 2-vs-48-total production ratio.
    const allCaptures = [search, drill, ...thirdPartyNoise, ...sameOriginNoise];
    expect(allCaptures).toHaveLength(48);

    writeRunDir(runRoot, allCaptures);

    const siteId = `noise-admission-scale-test-${process.pid}`;
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
    expect(contract).not.toContain("urgency-widget");
    expect(contract).not.toContain("adsrvr.org");
    expect(contract).not.toContain("googletagmanager.com");
    expect(contract).not.toContain("doubleclick.net");
    expect(contract).not.toContain("facebook.net");
    expect(contract).not.toContain("hotjar.com");
  });
});
