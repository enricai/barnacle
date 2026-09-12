import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildMulticallHeterogeneousActionStepsWithDrillDown } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Combines all three of the report's verification hooks in a single run,
 * the one shape no sibling e2e file exercises together: an own-backend
 * auth -> paged-listing -> per-item drill chain (the shape
 * {@link buildMulticallHeterogeneousActionStepsWithDrillDown} already
 * models), rehosted onto a synthetic own-backend hostname, interleaved with
 * dozens of third-party-host 2xx telemetry POSTs, plus a declared
 * submitEndpointPattern (requireSubmitEndpointMatch: true) naming the drill
 * call as the submit target. A still-present host-provenance defect would
 * surface as "browser-flow-only"/a frozen-varying-param error; a
 * still-present pattern-override defect would surface as the paged-listing
 * endpoint (not the drill endpoint) winning the submit target outright, or
 * the paged-listing step it depends on being dropped from the chain instead
 * of surviving as a step leading up to that submit target.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.own-backend-paged-drill-fixture.example.com";
const THIRD_PARTY_HOSTS = [
  "beacon-one.third-party-telemetry.example.net",
  "beacon-two.third-party-telemetry.example.org",
];
const DECOY_TELEMETRY_COUNT = 30;

/** Rehosts a fixture capture's URL onto the synthetic own-backend host, keeping its path/query. */
function rehostCapture(capture: Capture): Capture {
  const rehostedUrl = new URL(capture.url);
  rehostedUrl.host = OWN_BACKEND_HOST;
  return { ...capture, url: rehostedUrl.toString() };
}

/**
 * The own-backend auth -> paged-listing (two pages) -> per-item drill chain,
 * reusing the report's multicall fixture rather than inventing a new shape.
 * The fixture's terminal drill call is duplicated with a second productId so
 * the declared pattern below matches two captures — the same >=2-match
 * shape the drill submission needs to be recognized as a multi-step
 * submission flow rather than a single-endpoint read.
 */
function ownBackendAuthPagedDrillCaptures(): Capture[] {
  const [toggles, authz, productsPage1, productsPage2, drillP1] =
    buildMulticallHeterogeneousActionStepsWithDrillDown().map((step) =>
      rehostCapture(step.capture)
    );
  const drillP2: Capture = {
    ...drillP1!,
    timestamp: "2024-01-01T00:00:05Z",
    requestPostData: '{"productId":"p2"}',
    responseBody: { units: [{ unitId: "s2" }], exchangeRate: 1.0 },
  };
  return [toggles!, authz!, productsPage1!, productsPage2!, drillP1!, drillP2];
}

/**
 * Dozens of 2xx POST beacon captures on two distinct non-own-backend hosts,
 * mirroring the telemetry/analytics shape from the report -- high count, no
 * operationName, interleaved with the real own-backend chain.
 */
function thirdPartyTelemetryCaptures(): Capture[] {
  return Array.from({ length: DECOY_TELEMETRY_COUNT }, (_, i) => {
    const host = THIRD_PARTY_HOSTS[i % THIRD_PARTY_HOSTS.length]!;
    return {
      timestamp: "2024-01-01T00:00:10.000Z",
      phase: "home",
      method: "POST",
      url: `https://${host}/collect/beacon`,
      status: 200,
      requestHeaders: { "Content-Type": "application/json" },
      requestPostData: JSON.stringify({ event: i }),
      responseHeaders: {},
      responseBody: {},
      operationName: null,
      query: null,
      variables: null,
      decodedParams: null,
    };
  });
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

describe("recon-generate CLI — paged-listing -> drill submission stays host-gated and honors the declared submitEndpointPattern under third-party noise", () => {
  it("selects the drill endpoint as the submit target, host-gated to the own backend, with dozens of third-party 2xx POSTs interleaved", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-paged-drill-submission-host-pattern-e2e-"));
    const runRoot = join(workDir, "run");

    // Interleave the third-party telemetry noise between own-backend
    // captures rather than appending it, so a chronological/positional
    // fallback can't dodge the interleaving.
    const ownBackend = ownBackendAuthPagedDrillCaptures();
    const telemetry = thirdPartyTelemetryCaptures();
    const interleaved: Capture[] = [];
    let telemetryIndex = 0;
    const telemetryPerSlot = Math.ceil(telemetry.length / ownBackend.length);
    ownBackend.forEach((capture) => {
      interleaved.push(capture);
      for (let j = 0; j < telemetryPerSlot && telemetryIndex < telemetry.length; j++) {
        interleaved.push(telemetry[telemetryIndex]!);
        telemetryIndex++;
      }
    });
    while (telemetryIndex < telemetry.length) {
      interleaved.push(telemetry[telemetryIndex]!);
      telemetryIndex++;
    }
    writeRunDir(runRoot, interleaved);

    const siteId = `paged-drill-submission-host-pattern-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "authorize session" },
          { step: "browse paged product listing" },
          { step: "drill into unit availability", submitStep: true },
        ],
        submitEndpointPattern: "/listings-avail-api/available-units/$",
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
    const output = `${result.stdout}\n${result.stderr}`;

    // Never mistake the interleaved third-party hosts for a second in-flow
    // host and downgrade to the browser-only fallback.
    expect(output).not.toContain("browser-flow-only");
    expect(output).not.toContain("cross-domain hop");

    // Never hit the frozen-varying-param drill guard on a third-party host.
    expect(result.stderr).not.toContain("would freeze a value");

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // No third-party host string reaches the emitted contract.
    for (const host of THIRD_PARTY_HOSTS) {
      expect(contract).not.toContain(host);
    }

    // The submit target traces to the declared pattern's drill endpoint...
    expect(contract).toContain("/listings-avail-api/available-units/");

    // ...and the auth mint step and the paged-listing endpoint it depends on
    // both survive as chain steps leading up to that submit target —
    // truncating at the last pattern match keeps the whole chain instead of
    // collapsing to the bare matching capture(s).
    expect(contract).toContain("/listings-avail-api/authz/private");
    expect(contract).toContain("/listings-avail-api/available-products/");

    // The full chain shape survives, not just the selected submit endpoint:
    // toggles, authz, the two paged-listing calls collapsed to one (same
    // endpoint, same response shape, varying only by the pagination-shaped
    // `page` body field), and the two per-item drill calls hoisted to one
    // parameterized call (same endpoint and response shape, varying only a
    // non-pagination `productId` field — the report's expected shape for a
    // per-item drill, not one raw `httpClient` call per drill capture) —
    // four total. Unrolling the drill back to one call per item, or
    // collapsing the whole chain down to only the matching-pattern
    // capture(s), would both change this count, which `toContain` checks on
    // individual endpoint strings can't detect.
    const httpClientCallCount = (contract.match(/await httpClient\(/g) ?? []).length;
    expect(httpClientCallCount).toBe(4);

    // baseUrl is host-gated to the declared own-backend host.
    expect(contract).toContain(`https://${OWN_BACKEND_HOST}`);
  }, 30_000);
});
