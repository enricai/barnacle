import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emitMultiStepExecuteHttp } from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Reproduces the report's multi-field-collision shape directly (not the
 * single-engineered-match or fold/drill double-pass tests already covered
 * elsewhere): THREE independent producer values whose accessor NAMES
 * textually prefix-collide (`field1`/`field12`/`field123`) and whose VALUES
 * each independently, coincidentally appear as 8+-char substrings inside one
 * same-host, fixed-query, zero-variance opaque path — with no fold/drill/
 * chain relationship involved. `payloadAccessorByValue` (recon-generate.ts
 * ~5040-5053) registers every string leaf >= MIN_STATE_VALUE_LENGTH as a
 * binding regardless of whether the match site is a semantically-opaque,
 * non-semantic path segment, and `interpolateStateValues`'s single guarded
 * pass only prevents re-matching an ALREADY-emitted placeholder's own span —
 * it does nothing to stop three separately-registered bindings from each
 * independently matching adjacent value occurrences inside the same opaque
 * segment and being emitted as separate, textually-nested placeholders.
 */

const FIELD1_VALUE = "AB1234CD";
const FIELD12_VALUE = "EF5678GH";
const FIELD123_VALUE = "IJ9012KL";
const OPAQUE_SEGMENT = `wJbfQL-${FIELD1_VALUE}-${FIELD12_VALUE}-${FIELD123_VALUE}-K0X`;

function beaconUrl(host: string): string {
  return `https://${host}/beacon/${OPAQUE_SEGMENT}/responder.html?env=prod`;
}

describe("interpolateStateValues / payloadAccessorByValue — three prefix-colliding accessors vs. one opaque path", () => {
  function emitBeaconLine(): string {
    const producer = {
      capture: buildCapture({
        url: "https://api.example.com/session/start",
        requestPostData: null,
        responseBody: {
          field1: FIELD1_VALUE,
          field12: FIELD12_VALUE,
          field123: FIELD123_VALUE,
        },
        timestamp: "2026-01-01T00:00:00Z",
      }),
      varName: "r0",
      produces: [
        { kind: "body" as const, name: "field1", path: ["field1"] },
        { kind: "body" as const, name: "field12", path: ["field12"] },
        { kind: "body" as const, name: "field123", path: ["field123"] },
      ],
      isMultipart: false,
      isCrossDomain: false,
    };
    const beacon = {
      capture: buildCapture({
        url: beaconUrl("api.example.com"),
        requestPostData: null,
        responseBody: { ack: true },
        timestamp: "2026-01-01T00:00:01Z",
      }),
      varName: "r1",
      produces: [],
      isMultipart: false,
      isCrossDomain: false,
    };

    const body = emitMultiStepExecuteHttp(
      [producer, beacon] as unknown as Parameters<typeof emitMultiStepExecuteHttp>[0],
      null,
      { stringMessageKey: null, nestedErrorPaths: [] },
      new Map(),
      new Set(),
      new Map(),
      new Set(),
      new Map(),
      new Map(),
      "https://api.example.com",
      new Map(),
      new Map()
    );

    const match = /httpClient\(`([^`]*wJbfQL[^`]*)`/.exec(body);
    if (!match) throw new Error("beacon url not found in emitted code");
    return match[1]!;
  }

  it("never opens a nested placeholder", () => {
    const url = emitBeaconLine();

    expect(url).not.toMatch(/\$\{[^}]*\$\{/);
  });

  it("never splices any of the three colliding fields into the opaque segment", () => {
    const url = emitBeaconLine();
    const opaqueSlotMatch = url.match(/wJbfQL-(.*?)-K0X/);
    expect(opaqueSlotMatch, url).not.toBeNull();
    const opaqueSlot = opaqueSlotMatch![1]!;

    expect(opaqueSlot).not.toMatch(/\$\{/);
  });

  it("renders the beacon call as an exact literal when the opaque path is excluded from interpolation", () => {
    const url = emitBeaconLine();

    if (!url.includes("${")) {
      expect(url).toContain(OPAQUE_SEGMENT);
    }
  });
});

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "jobs.example.com";

function sessionCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:00Z",
    phase: "action",
    method: "POST",
    url: `https://${OWN_BACKEND_HOST}/api/v1/session/start`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: '{"init":true}',
    responseHeaders: { "content-type": "application/json" },
    responseBody: {
      field1: FIELD1_VALUE,
      field12: FIELD12_VALUE,
      field123: FIELD123_VALUE,
    },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

function beaconCapture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:01Z",
    phase: "action",
    method: "GET",
    url: beaconUrl(OWN_BACKEND_HOST),
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: { "content-type": "application/json" },
    responseBody: { ack: true },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

function writeRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));
  writeFileSync(join(root, "graphql", "000-start-session.json"), JSON.stringify(sessionCapture()));
  writeFileSync(join(root, "graphql", "001-record-beacon.json"), JSON.stringify(beaconCapture()));
}

function writeFlowFile(siteOutDir: string): void {
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({
      steps: [{ step: "start session" }, { step: "record view beacon", submitStep: true }],
      ownBackendHostnames: [OWN_BACKEND_HOST],
    })
  );
}

function generate(runRoot: string, siteId: string): ReturnType<typeof spawnSync> {
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

describe("recon-generate CLI — three prefix-colliding accessors vs. one opaque beacon path, no fold/drill involved", () => {
  it("never nests placeholders and never splices a payload field into the opaque path", () => {
    workDir = mkdtempSync(
      join(tmpdir(), "barnacle-multi-field-collision-opaque-path-splice-guard-e2e-")
    );
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `multi-field-collision-opaque-path-splice-guard-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    writeFlowFile(siteOutDir);

    const result = generate(runRoot, siteId);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // No invalidly-nested placeholder anywhere in the emitted file.
    expect(contract).not.toMatch(/\$\{[^}]*\$\{/);

    const beaconLineMatch = contract.match(/`[^`]*wJbfQL[^`]*K0X[^`]*`/);

    // The beacon may legitimately be excluded as noise (fixed-query,
    // zero-variance, single occurrence) — either outcome is acceptable, but
    // if it IS emitted, its opaque segment must be untouched.
    if (!beaconLineMatch) return;

    const beaconUrlTemplate = beaconLineMatch[0];
    const opaqueSlotMatch = beaconUrlTemplate.match(/wJbfQL-(.*?)-K0X/);
    expect(opaqueSlotMatch, beaconUrlTemplate).not.toBeNull();
    const opaqueSlot = opaqueSlotMatch![1]!;

    expect(opaqueSlot).not.toContain("field1");
    expect(opaqueSlot).not.toContain("field12");
    expect(opaqueSlot).not.toContain("field123");
    expect(opaqueSlot).not.toMatch(/\$\{/);

    if (!beaconUrlTemplate.includes("${")) {
      expect(beaconUrlTemplate).toContain(OPAQUE_SEGMENT);
    }
  }, 30_000);
});
