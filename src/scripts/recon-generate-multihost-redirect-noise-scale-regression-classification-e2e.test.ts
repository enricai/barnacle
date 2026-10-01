import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins symptom #1 from the report at a scale the existing
 * recon-generate-noisy-cross-domain-archive-classification-submit-fold-compile-cascade-e2e
 * test (one noise host, ~30 total captures) never reaches: a REST-majority
 * archive of thousands of own-backend captures diluted by a GraphQL noise
 * minority split across TWO distinct cross-registrable-domain hosts, which
 * is the shape isGraphQL's isZeroVarianceRepeatCapture /
 * rescuedInvariantEndpoints dilution logic is scale-dependent on. Isolated
 * to the classification check alone, independent of the submit-pattern,
 * fold, and compile symptoms the cascade test already covers.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const PRIMARY_HOST = "www.catalog-fixture.example.org";
// Two genuinely distinct registrable domains from PRIMARY_HOST and from each
// other, modeling a same-company SSO bounce that resolves against more than
// one login surface, neither of which is the flow's own backend.
const NOISE_HOST_A = "login.auth-fixture.example.net";
const NOISE_HOST_B = "www.auth-fixture.example.net";

const REST_CAPTURE_COUNT = 3100;
const NOISE_CAPTURE_COUNT = 400;

function restCapture(overrides: {
  url: string;
  requestPostData: string | null;
  responseBody: unknown;
  timestamp: string;
}): Capture {
  return {
    timestamp: overrides.timestamp,
    phase: "action",
    method: "GET",
    url: overrides.url,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: overrides.requestPostData,
    responseHeaders: { "content-type": "application/json" },
    responseBody: overrides.responseBody,
    operationName: null,
    query: null,
    variables: null,
    decodedParams:
      overrides.requestPostData !== null ? JSON.parse(overrides.requestPostData) : null,
  };
}

function graphqlCapture(overrides: {
  url: string;
  operationName: string;
  query: string;
  responseBody: unknown;
  timestamp: string;
}): Capture {
  return {
    timestamp: overrides.timestamp,
    phase: "home",
    method: "POST",
    url: overrides.url,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({
      operationName: overrides.operationName,
      query: overrides.query,
    }),
    responseHeaders: { "content-type": "application/json" },
    responseBody: overrides.responseBody,
    operationName: overrides.operationName,
    query: overrides.query,
    variables: null,
    decodedParams: null,
  };
}

/**
 * ~3100 own-backend REST captures (varying slot availability, so none
 * collapse to a trivially zero-variance repeat) interleaved against ~400
 * GraphQL noise captures split across two distinct cross-registrable-domain
 * hosts, scattered throughout array order rather than isolated to one block.
 */
function writeRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));

  let index = 0;
  const write = (capture: Capture, label: string): void => {
    writeFileSync(
      join(root, "graphql", `${String(index).padStart(5, "0")}-${label}.json`),
      JSON.stringify(capture)
    );
    index++;
  };

  const timestampFor = (i: number): string => {
    const second = i % 60;
    const minute = Math.floor(i / 60) % 60;
    const hour = 10 + Math.floor(i / 3600);
    return `2026-08-18T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000Z`;
  };

  const restNoise = (i: number): void =>
    write(
      restCapture({
        url: `https://${PRIMARY_HOST}/api/orders/availability`,
        requestPostData: null,
        responseBody: { slots: [`slot-${i}`] },
        timestamp: timestampFor(i),
      }),
      `availability-${i}`
    );

  const authNoise = (i: number, host: string, label: string): void =>
    write(
      graphqlCapture({
        url: `https://${host}/graphql`,
        operationName: "SessionRefresh",
        query: "mutation SessionRefresh($token: String!) { sessionRefresh(token: $token) { ok } }",
        responseBody: { data: { sessionRefresh: { ok: true } } },
        timestamp: timestampFor(i),
      }),
      label
    );

  const totalCaptures = REST_CAPTURE_COUNT + NOISE_CAPTURE_COUNT;
  let restEmitted = 0;
  let noiseEmitted = 0;
  for (let i = 0; i < totalCaptures; i++) {
    // Interleave noise roughly every ~8th slot (400 noise across ~3500
    // total), alternating between the two distinct noise hosts, rather than
    // confining it to a single contiguous block.
    const shouldEmitNoise =
      noiseEmitted < NOISE_CAPTURE_COUNT && (restEmitted >= REST_CAPTURE_COUNT || i % 8 === 0);
    if (shouldEmitNoise) {
      const host = noiseEmitted % 2 === 0 ? NOISE_HOST_A : NOISE_HOST_B;
      authNoise(i, host, `auth-redirect-noise-${noiseEmitted}`);
      noiseEmitted++;
      continue;
    }
    restNoise(restEmitted);
    restEmitted++;
  }
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate CLI — multi-host redirect noise at scale never flips a REST-majority archive to GraphQL", () => {
  it("classifies REST when ~3100 own-backend captures are diluted by ~400 GraphQL captures split across two distinct cross-registrable-domain hosts", () => {
    if (!existsSync(TSX_BIN)) {
      throw new Error("tsx not installed — cannot run the real CLI");
    }

    workDir = mkdtempSync(join(tmpdir(), "barnacle-multihost-scale-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `multihost-scale-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "check availability" }, { step: "confirm order", submitStep: true }],
        ownBackendHostnames: [PRIMARY_HOST, NOISE_HOST_A, NOISE_HOST_B],
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 1024 * 1024 * 64 }
    );

    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    expect(result.status, combinedOutput).toBe(0);

    // Symptom #1 — classification: GraphQL noise split across two distinct
    // cross-registrable-domain hosts, at a scale of thousands of captures,
    // must never flip a REST-majority flow to GraphQL.
    const classifiedRest =
      combinedOutput.includes(`generating plugin for ${siteId} (submission flow,`) ||
      combinedOutput.includes(`generating plugin for ${siteId} (single-endpoint REST,`);
    expect(classifiedRest, combinedOutput).toBe(true);
    expect(combinedOutput).not.toContain(`generating plugin for ${siteId} (GraphQL,`);
  }, 120_000);
});
