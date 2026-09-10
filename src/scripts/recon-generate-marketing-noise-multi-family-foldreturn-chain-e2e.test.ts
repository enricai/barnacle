import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { Capture } from "@/scripts/recon-shared";

/**
 * The report's own verification hook (recon-generate-host-gated-action-
 * sequence-admits-unrelated-marketing-endpoint-tripping-required-url-field-
 * guard.md) names its full real chain as two structurally-distinct
 * own-backend endpoint families — `authz/private` + a paged listing on one
 * family, a drill-down `foldReturn`-joined onto it on a SECOND family — that
 * share only a suffix token (`vas`), never a literal path prefix, plus a
 * same-host marketing capture whose response carries required *Url-family
 * fields. Every existing e2e either covers the fold/submitEndpointPattern
 * chain with a plain non-Url noise capture
 * (recon-generate-submitendpointpattern-foldreturn-chain-preserved-e2e) or
 * covers the *Url-family noise guard against a SINGLE-family chain
 * (recon-generate-marketing-endpoint-noise-guard-e2e). Neither exercises the
 * combination at the full CLI level, which is the gap this test closes.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.own-backend-marketing-noise-foldreturn-chain-fixture.example.com";

// Two structurally-distinct endpoint families: both compound path segments
// share the `vas` token, but neither is a literal prefix of the other.
const AUTHZ_URL = `https://${OWN_BACKEND_HOST}/dcl-apps-productavail-vas/authz/private`;
const LISTING_URL = `https://${OWN_BACKEND_HOST}/dcl-apps-productavail-vas/available-products/`;
const DRILL_URL = `https://${OWN_BACKEND_HOST}/dcl-apps-sailingavailability-vas/available-sailings/`;

// A same-host marketing/promotions capture whose compound path shares no
// token with either endpoint family and whose response carries a required
// *Url-family field nothing downstream references — the report's
// `webBannerImageUrl` shape.
const NOISE_URL = `https://${OWN_BACKEND_HOST}/dvic-promotions-widget/home-banner`;

function buildCapture(overrides: {
  url: string;
  requestPostData: string | null;
  responseBody: unknown;
  timestamp: string;
}): Capture {
  return {
    timestamp: overrides.timestamp,
    phase: "action",
    method: "POST",
    url: overrides.url,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: overrides.requestPostData,
    responseHeaders: { "content-type": "application/json" },
    responseBody: overrides.responseBody,
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

function chainCaptures(): Capture[] {
  return [
    buildCapture({
      url: AUTHZ_URL,
      requestPostData: "{}",
      responseBody: { result: "anonymous", successful: true },
      timestamp: "2024-01-01T00:00:00Z",
    }),
    buildCapture({
      url: NOISE_URL,
      requestPostData: '{"pageId":"home"}',
      responseBody: {
        mobileApp_webBannerImageUrl: "https://cdn.example.com/banner-mobile-app.png",
        webBannerImageUrl: "https://cdn.example.com/banner.png",
      },
      timestamp: "2024-01-01T00:00:00.500Z",
    }),
    buildCapture({
      url: LISTING_URL,
      requestPostData: '{"page":1}',
      responseBody: {
        totalPages: 2,
        products: [{ productId: "p1" }],
      },
      timestamp: "2024-01-01T00:00:01Z",
    }),
    buildCapture({
      url: LISTING_URL,
      requestPostData: '{"page":2}',
      responseBody: {
        totalPages: 2,
        products: [{ productId: "p2" }],
      },
      timestamp: "2024-01-01T00:00:02Z",
    }),
    buildCapture({
      url: DRILL_URL,
      requestPostData: '{"productId":"p1"}',
      responseBody: { sailings: [{ productId: "p1", sailingId: "s1" }] },
      timestamp: "2024-01-01T00:00:03Z",
    }),
  ];
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

describe("recon-generate CLI — multi-family foldReturn chain survives an interleaved same-host *Url noise capture", () => {
  it("exits 0, preserves both endpoint families and the fold join, and excludes the noise capture's fields and path", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-marketing-noise-multi-family-foldreturn-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, chainCaptures());

    const siteId = `marketing-noise-multi-family-foldreturn-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "authorize session" },
          { step: "browse paged product listing" },
          { step: "drill into sailing availability", submitStep: true },
        ],
        submitEndpointPattern: "available-sailings",
        requireSubmitEndpointMatch: true,
        ownBackendHostnames: [OWN_BACKEND_HOST],
        foldReturn: {
          endpointPattern: "available-sailings",
          resultsPath: "products",
          drillResultsPath: "sailings",
          joinFields: ["productId"],
        },
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // Both structurally-distinct endpoint families survive as chain steps.
    expect(contract).toContain("/dcl-apps-productavail-vas/authz/private");
    expect(contract).toContain("/dcl-apps-productavail-vas/available-products/");
    expect(contract).toContain("/dcl-apps-sailingavailability-vas/available-sailings/");

    // The fold/join field between the two families is present.
    expect(contract).toContain("productId");

    // The interleaved same-host noise capture never leaks into the contract:
    // neither its required *Url-family fields nor its own path.
    expect(contract).not.toContain("webBannerImageUrl");
    expect(contract).not.toContain("/dvic-promotions-widget/home-banner");
  }, 30_000);
});
