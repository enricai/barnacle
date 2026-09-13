import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  buildCapture,
  buildSessionHeartbeatNoiseStep,
} from "@/scripts/recon-generate-multicall-fixture";
import { buildMultiEndpointSubmissionActionSteps } from "@/scripts/recon-generate-multiendpoint-fixture";
import type { Capture } from "@/scripts/recon-shared";

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

function writeRunDir(runRoot: string, captures: Capture[]): void {
  const capturesDir = join(runRoot, "graphql");
  mkdirSync(capturesDir, { recursive: true });
  mkdirSync(join(runRoot, "replays"), { recursive: true });
  mkdirSync(join(runRoot, "aux"), { recursive: true });
  writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
  captures.forEach((capture, index) => {
    const filename = `${String(index).padStart(3, "0")}-capture.json`;
    writeFileSync(join(capturesDir, filename), JSON.stringify(capture));
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

describe("recon-generate: fixed-query zero-variance non-API noise is excluded without a *Url-field self-heal trigger", () => {
  /**
   * Required item 3 from the recon report: a same-host, fixed-query,
   * zero-request-variance page-load-chrome-style capture (no compound or
   * repeated path segment, no `*Url`-suffixed response field) must be
   * excluded from the generated contract on the FIRST generation pass, purely
   * via the engine's existing site-agnostic mechanisms — never a hardcoded
   * per-endpoint special case, and never by needing a self-heal WARN retry
   * (the required-URL-field guard this fixture is deliberately shaped to
   * never trigger, since it carries no `*Url` field to attribute).
   */
  it("excludes the session-heartbeat capture on the first generation pass", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-fixed-query-zero-variance-noise-"));
    const runRoot = join(workDir, "run");

    const actionCaptures = buildMultiEndpointSubmissionActionSteps().map((s) => s.capture);
    const noiseCapture = buildSessionHeartbeatNoiseStep("2024-01-01T00:00:00.500Z").capture;

    const noisePath = new URL(noiseCapture.url).pathname;
    const body = noiseCapture.responseBody as Record<string, unknown>;
    expect(Object.keys(body).some((key) => key.endsWith("Url"))).toBe(false);
    expect(noisePath.split("/").filter(Boolean)).toHaveLength(1);

    const submitCapture = actionCaptures[actionCaptures.length - 1]!;
    const submitPath = new URL(submitCapture.url).pathname;
    const allCaptures = [...actionCaptures, noiseCapture];
    writeRunDir(runRoot, allCaptures);

    const siteId = `fixed-query-zero-variance-noise-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "fill out applicant, address, contact, employment, and attachment sections" },
          { step: "submit address section", submitStep: true },
        ],
      })
    );

    const result = runGenerate(siteId, runRoot);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).not.toMatch(/WARN.*self-heal/i);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contract).not.toContain(noisePath);
    expect(contract).not.toContain("alive");
    expect(contract).not.toContain("intervalMs");
    expect(contract).toContain(submitPath);
  }, 30_000);
});

/**
 * Regression at realistic corpus scale for #bugfix-002: a same-host,
 * fixed-query, zero-business-value beacon and a same-host, flat (no query),
 * fixed-request, zero-business-value poll must both stay excluded from the
 * generated contract even when surrounded by 10+ genuine own-backend
 * endpoints — not just the handful of captures the narrower existing
 * fixtures above use. The poll's path has only ONE compound segment
 * (matching the shape a real polled endpoint could legitimately have), so
 * it can only be told apart from a genuine single-compound-segment endpoint
 * by its response carrying no business-relevant state, not by path shape
 * alone.
 */
describe("recon-generate CLI — same-host zero-business-value noise stays excluded at realistic corpus scale", () => {
  const OWN_BACKEND_HOST = "www.own-backend-realistic-scale-noise-exclusion.example.com";
  const BEACON_URL = `https://${OWN_BACKEND_HOST}/authenticator/responder.html?clientId=WEB&environment=PROD`;
  const POLL_URL = `https://${OWN_BACKEND_HOST}/feature-toggles/product-avail`;
  const LISTING_URL = `https://${OWN_BACKEND_HOST}/available-products/`;
  const DRILL_URL = `https://${OWN_BACKEND_HOST}/available-sailings/`;

  const BEACON_FIRE_COUNT = 14;
  const POLL_FIRE_COUNT = 6;
  const LISTING_PAGE_COUNT = 8;
  const DRILL_ITEM_COUNT = 3;

  /** 10 further genuine own-backend section endpoints, each hit exactly
   * once, each carrying real per-call response data — the realistic
   * surrounding corpus a small fixture's own captures can't dilute or
   * reveal threshold effects against. */
  // Plain single-word paths: each names a distinct chain step the way a
  // real multi-section flow does, and carries no compound-segment token of
  // its own, so this fixture's own generalization signal (response
  // business-value) is what's under test, independent of the pre-existing,
  // out-of-scope token-overlap heuristic that a hyphenated own-backend path
  // sharing no word with any sibling can otherwise be caught by.
  const SECTION_NAMES = [
    "profile",
    "address",
    "contact",
    "employment",
    "attachments",
    "documents",
    "loyalty",
    "payment",
    "review",
    "confirmation",
  ];

  function zeroVarianceNoiseAlongsideRealisticCorpus(): Capture[] {
    const beacon = Array.from({ length: BEACON_FIRE_COUNT }, (_, i) =>
      buildCapture({
        url: BEACON_URL,
        requestPostData: "opaque-fixed-payload",
        responseBody: { ok: true },
        timestamp: `2024-01-01T00:00:${String(i).padStart(2, "0")}Z`,
      })
    );
    const poll = Array.from({ length: POLL_FIRE_COUNT }, (_, i) =>
      buildCapture({
        method: "POST",
        url: POLL_URL,
        requestPostData: "{}",
        responseBody: {},
        timestamp: `2024-01-01T00:01:${String(i).padStart(2, "0")}Z`,
      })
    );
    const listing = Array.from({ length: LISTING_PAGE_COUNT }, (_, i) =>
      buildCapture({
        url: `${LISTING_URL}?_=${1700000000 + i}`,
        requestPostData: JSON.stringify({ page: i + 1 }),
        responseBody: {
          totalPages: LISTING_PAGE_COUNT,
          products: [{ productId: `p${i + 1}` }],
        },
        timestamp: `2024-01-01T00:02:${String(i).padStart(2, "0")}Z`,
      })
    );
    const drills = Array.from({ length: DRILL_ITEM_COUNT }, (_, i) =>
      buildCapture({
        url: DRILL_URL,
        requestPostData: JSON.stringify({ productId: `p${i + 1}` }),
        responseBody: { units: [{ unitId: `s${i + 1}` }], exchangeRate: 1.0 },
        timestamp: `2024-01-01T00:03:${String(i).padStart(2, "0")}Z`,
      })
    );
    const sections = SECTION_NAMES.map((name, i) =>
      buildCapture({
        url: `https://${OWN_BACKEND_HOST}/${name}/`,
        requestPostData: JSON.stringify({ value: `${name}-value-${i}` }),
        responseBody: { [`${name}Id`]: `${name}-${i}`, savedAt: `2024-01-01T00:04:${i}Z` },
        timestamp: `2024-01-01T00:04:${String(i).padStart(2, "0")}Z`,
      })
    );
    return [...beacon, ...poll, ...listing, ...drills, ...sections];
  }

  it("excludes both the fixed-query beacon and the flat zero-variance poll while keeping every genuine endpoint", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-realistic-scale-noise-exclusion-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, zeroVarianceNoiseAlongsideRealisticCorpus());

    const siteId = `realistic-scale-noise-exclusion-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "browse paged product listing" },
          { step: "drill into sailing availability" },
          ...SECTION_NAMES.map((name) => ({ step: `fill out ${name} section` })),
          { step: "review and confirm summary", submitStep: true },
        ],
        ownBackendHostnames: [OWN_BACKEND_HOST],
      })
    );

    const result = runGenerate(siteId, runRoot);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // The beacon fired 14 times with a byte-identical fixed query and no
    // business-relevant response.
    expect(contract).not.toContain("authenticator");
    expect(contract).not.toContain("responder");

    // The poll fired 6 times with no query string at all, a fixed body, and
    // an empty (zero-business-value) response — the same category of noise
    // as the beacon, but reachable only via response-value reasoning since
    // its path has just one compound segment, the same shape a genuine
    // polled endpoint could have.
    expect(contract).not.toContain("feature-toggles");
    expect(contract).not.toContain("product-avail");

    // Every genuine own-backend endpoint must still be emitted.
    expect(contract).toContain("available-products");
    expect(contract).toContain("available-sailings");
    for (const name of SECTION_NAMES) {
      expect(contract).toContain(name);
    }
  }, 30_000);
});
