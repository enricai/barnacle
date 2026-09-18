import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Proves end to end that a consumer-declared `--value-constraints` bound
 * enforces a domain limit even when NO response in the run ever carries a
 * max/capacity/limit-shaped leaf for the generator's own auto-inference to
 * key off — the silent-failure shape of an endpoint answering wrong data
 * instead of an error for an out-of-bounds request, rather than the
 * response-derived-ceiling case recon-generate-value-constraint-validation-
 * e2e.test.ts already covers.
 *
 * A second case proves omitting `--value-constraints` reproduces today's
 * unconstrained z.number() output byte-for-byte against the explicit
 * `--value-constraints none` opt-out, guarding against a regression in the
 * default (no-flag) path.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.declared-value-constraint-validation-fixture.example.com";
const SEARCH_URL = `https://${OWN_BACKEND_HOST}/lodging/search/`;
const HOLD_URL = `https://${OWN_BACKEND_HOST}/lodging/hold/`;
const CONFIRM_URL = `https://${OWN_BACKEND_HOST}/lodging/confirm/`;

/**
 * No response anywhere in this run carries a max/capacity/limit-shaped leaf
 * for `partySize` to be paired against — unlike the response-derived-ceiling
 * fixture, the generator's own auto-inference has nothing to key off here.
 */
function fixtureCaptures(): Capture[] {
  const search = buildCapture({
    url: SEARCH_URL,
    requestPostData: JSON.stringify({ query: "lakeside" }),
    responseBody: { results: [{ unitId: "unit-a" }] },
    timestamp: "2026-05-01T00:00:00Z",
  });
  const hold = buildCapture({
    url: HOLD_URL,
    requestPostData: JSON.stringify({ unitId: "unit-a", partySize: 2 }),
    responseBody: { held: true },
    timestamp: "2026-05-01T00:00:01Z",
  });
  const confirm = buildCapture({
    url: CONFIRM_URL,
    requestPostData: JSON.stringify({ unitId: "unit-a", partySize: 3 }),
    responseBody: { confirmed: true },
    timestamp: "2026-05-01T00:00:02Z",
  });
  return [search, hold, confirm];
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

function writeValueConstraintsModule(dir: string): string {
  const constraintsPath = join(dir, "value-constraints.mjs");
  writeFileSync(
    constraintsPath,
    `export const valueConstraints = {
  partySize: { max: 4 },
};
`
  );
  return constraintsPath;
}

function runGenerate(
  runRoot: string,
  siteId: string,
  extraArgs: string[]
): ReturnType<typeof spawnSync> {
  return spawnSync(
    TSX_BIN,
    [
      GENERATE_SCRIPT,
      "--site-id",
      siteId,
      "--run-dir",
      runRoot,
      "--emit",
      "ts",
      "--force",
      ...extraArgs,
    ],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
}

let workDir: string | null = null;
const siteOutDirs: string[] = [];

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  for (const dir of siteOutDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  workDir = null;
});

describe("recon-generate CLI — declared --value-constraints bounds a field no capture ever exposed a ceiling for", () => {
  it("rejects an over-limit value and accepts every recon-observed value once --value-constraints declares an explicit max", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-declared-value-constraint-validation-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `declared-value-constraint-validation-e2e-test-${process.pid}`;
    const siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    siteOutDirs.push(siteOutDir);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "search for a lakeside unit" },
          { step: "place a hold on the selected unit" },
          { step: "confirm the unit hold", submitStep: true },
        ],
        submitEndpointPattern: "lodging/confirm",
        requireSubmitEndpointMatch: true,
        ownBackendHostnames: [OWN_BACKEND_HOST],
      })
    );

    const constraintsPath = writeValueConstraintsModule(workDir);

    const result = runGenerate(runRoot, siteId, ["--value-constraints", constraintsPath]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // The declared bound overrides the field's emitted zod expression even
    // though no response leaf in this run is max/capacity/limit-shaped.
    expect(contract).toMatch(/partySize:\s*z\.number\(\)\.max\(4\),/);
    expect(contract).not.toMatch(/partySize:\s*z\.number\(\),/);

    const payloadSchemaMatch = contract.match(
      /const \w+PayloadSchema = ([\s\S]*?);\n\nexport type/
    );
    expect(payloadSchemaMatch, contract).not.toBeNull();
    const payloadSchemaExpr = payloadSchemaMatch![1]!;
    const PayloadSchema = new Function("z", `return ${payloadSchemaExpr};`)(z) as z.ZodType;

    const BASE_VALID_PAYLOAD = {
      BaseUrl: `https://${OWN_BACKEND_HOST}`,
      query: "lakeside",
      unitId: "unit-a",
    };

    // Every partySize value actually observed in the fixture still parses.
    expect(PayloadSchema.safeParse({ ...BASE_VALID_PAYLOAD, partySize: 2 }).success).toBe(true);
    expect(PayloadSchema.safeParse({ ...BASE_VALID_PAYLOAD, partySize: 3 }).success).toBe(true);

    // A value that exceeds the declared bound is rejected, even though no
    // response ever carried a max/capacity/limit-shaped leaf to derive it
    // from — the exact silent-failure shape of an endpoint answering wrong
    // data instead of an error for an out-of-bounds request.
    expect(PayloadSchema.safeParse({ ...BASE_VALID_PAYLOAD, partySize: 99 }).success).toBe(false);
  }, 30_000);

  it("reproduces today's unconstrained z.number() output byte-for-byte when --value-constraints is omitted", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-declared-value-constraint-validation-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `declared-value-constraint-omission-e2e-test-${process.pid}`;
    const siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    siteOutDirs.push(siteOutDir);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "search for a lakeside unit" },
          { step: "place a hold on the selected unit" },
          { step: "confirm the unit hold", submitStep: true },
        ],
        submitEndpointPattern: "lodging/confirm",
        requireSubmitEndpointMatch: true,
        ownBackendHostnames: [OWN_BACKEND_HOST],
      })
    );

    const resultOmitted = runGenerate(runRoot, siteId, []);
    expect(resultOmitted.status, `${resultOmitted.stdout}\n${resultOmitted.stderr}`).toBe(0);
    const contractOmitted = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    const resultNone = runGenerate(runRoot, siteId, ["--value-constraints", "none"]);
    expect(resultNone.status, `${resultNone.stdout}\n${resultNone.stderr}`).toBe(0);
    const contractNone = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // Omitting the flag reproduces the explicit opt-out byte-for-byte.
    expect(contractOmitted).toBe(contractNone);

    // Both leave partySize unconstrained — no defaulted bound sneaks in.
    expect(contractOmitted).toMatch(/partySize:\s*z\.number\(\),/);
    expect(contractOmitted).not.toContain(".max(");
  }, 30_000);
});
