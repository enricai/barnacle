import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Directly encodes the report's own verification hook at the CLI boundary: a
 * synthetic run with own-backend POSTs plus dozens of third-party 2xx POSTs
 * must select the same action sequence as with the third-party POSTs
 * removed. Mirrors the spawnSync/tmpdir/site-out-dir lifecycle of
 * recon-generate-nongraphql-thirdparty-decoy-host-provenance-e2e.test.ts and
 * recon-generate-cross-host-submission-e2e.test.ts. Distinct from both: this
 * proves the fix at the level of two full CLI runs compared against each
 * other, not a single run's assertions against fixed strings.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.own-backend-fixture.example.com";
const THIRD_PARTY_HOSTS = [
  "beacon-one.third-party-telemetry.example.net",
  "beacon-two.third-party-telemetry.example.org",
  "beacon-three.third-party-telemetry.example.io",
];

function restCapture(overrides: {
  phase: string;
  method: string;
  url: string;
  status: number;
  requestPostData: string | null;
  responseBody: unknown;
}): Capture {
  return {
    timestamp: "2026-08-18T10:23:03.000Z",
    phase: overrides.phase,
    method: overrides.method,
    url: overrides.url,
    status: overrides.status,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: overrides.requestPostData,
    responseHeaders: {},
    responseBody: overrides.responseBody,
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

/**
 * The own-backend transactional flow: auth -> list -> submit, three
 * distinct POST endpoints on the own-backend host.
 */
function ownBackendCaptures(): Capture[] {
  return [
    restCapture({
      phase: "auth",
      method: "POST",
      url: `https://${OWN_BACKEND_HOST}/api/accounts/login`,
      status: 200,
      requestPostData: JSON.stringify({ user: "tester" }),
      responseBody: { token: "abc" },
    }),
    restCapture({
      phase: "list",
      method: "POST",
      url: `https://${OWN_BACKEND_HOST}/api/listings/search`,
      status: 200,
      requestPostData: JSON.stringify({ q: "unit" }),
      responseBody: { items: [{ id: "1" }] },
    }),
    restCapture({
      phase: "submit",
      method: "POST",
      url: `https://${OWN_BACKEND_HOST}/api/listings/reserve`,
      status: 200,
      requestPostData: JSON.stringify({ listingId: "1" }),
      responseBody: { ok: true },
    }),
  ];
}

/**
 * Dozens of 2xx POST beacon captures on 2-3 distinct non-own-backend hosts —
 * high count, no operationName, mirroring analytics/telemetry SDK shapes.
 */
function thirdPartyTelemetryCaptures(): Capture[] {
  return THIRD_PARTY_HOSTS.flatMap((host, hostIndex) =>
    Array.from({ length: 20 + hostIndex * 15 }, (_, i) =>
      restCapture({
        phase: "home",
        method: "POST",
        url: `https://${host}/collect/beacon`,
        status: 200,
        requestPostData: JSON.stringify({ event: i }),
        responseBody: {},
      })
    )
  );
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

function writeSiteFlow(siteOutDir: string): void {
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({
      steps: [{ step: "search listings" }, { step: "reserve listing", submitStep: true }],
      ownBackendHostnames: [OWN_BACKEND_HOST],
    })
  );
}

function generate(runRoot: string, siteId: string) {
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

describe("recon-generate CLI — third-party telemetry POSTs must never change the selected action sequence", () => {
  it("selects the identical action sequence whether or not dozens of third-party 2xx POSTs are interleaved", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-thirdparty-telemetry-action-sequence-e2e-"));
    const runWithTelemetry = join(workDir, "run-with-telemetry");
    const runWithoutTelemetry = join(workDir, "run-without-telemetry");

    writeRunDir(runWithTelemetry, [...ownBackendCaptures(), ...thirdPartyTelemetryCaptures()]);
    writeRunDir(runWithoutTelemetry, ownBackendCaptures());

    const siteId = `thirdparty-telemetry-action-sequence-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);

    writeSiteFlow(siteOutDir);
    const resultWithTelemetry = generate(runWithTelemetry, siteId);
    expect(
      resultWithTelemetry.status,
      `${resultWithTelemetry.stdout}\n${resultWithTelemetry.stderr}`
    ).toBe(0);

    // Never a "browser-flow-only (cross-domain hop detected)" downgrade
    // caused by mistaking a telemetry host for a second in-flow host.
    expect(resultWithTelemetry.stdout).not.toContain("browser-flow-only");
    expect(resultWithTelemetry.stdout).not.toContain("cross-domain hop");

    const contractWithTelemetry = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    for (const host of THIRD_PARTY_HOSTS) {
      expect(contractWithTelemetry).not.toContain(host);
    }

    rmSync(siteOutDir, { recursive: true, force: true });
    writeSiteFlow(siteOutDir);
    const resultWithoutTelemetry = generate(runWithoutTelemetry, siteId);
    expect(
      resultWithoutTelemetry.status,
      `${resultWithoutTelemetry.stdout}\n${resultWithoutTelemetry.stderr}`
    ).toBe(0);

    const contractWithoutTelemetry = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // The report's own verification hook: identical action sequence
    // (submit target endpoint, step count/order, baseUrl) with or without
    // the third-party telemetry noise. The generated contract is fully
    // deterministic from the same siteId/flow/own-backend captures, so
    // byte-for-byte equality is the strongest available check.
    expect(contractWithTelemetry).toBe(contractWithoutTelemetry);
  }, 30_000);
});
