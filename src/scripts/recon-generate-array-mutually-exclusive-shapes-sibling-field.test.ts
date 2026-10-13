import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  collectRequestBodyValuesByKey,
  findFrozenVaryingDrillParams,
} from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins that two mutually exclusive filter-array shapes (4 elements sharing a
 * `;filterId=` suffix vs 6 elements with distinct `;filterType=` suffixes),
 * alongside a differing correlated sibling field, never surface a `filters.N`
 * slot as frozen-varying, while a genuinely varying unique key still does.
 * Generic hotel-search fixture.
 */

const ID_TAGGED = [
  "pool;filterId=amenityTag",
  "spa;filterId=amenityTag",
  "wifi;filterId=amenityTag",
  "gym;filterId=amenityTag",
];
const TYPE_TAGGED = [
  "2026-12;filterType=checkin",
  "SUITE;filterType=roomClass",
  "4;filterType=stars",
  "WW;filterType=chain",
  "SALE;filterType=promo",
  "KING;filterType=bed",
];

const body = (filters: string[], region: string): Record<string, unknown> => ({
  currency: "USD",
  region: "EU",
  filters,
  sorts: [{ criteria: "PRICE", region }],
});

const cap = (value: unknown): Capture =>
  ({ url: "https://x/hotels", method: "POST", requestPostData: JSON.stringify(value) }) as Capture;

describe("findFrozenVaryingDrillParams with exclusive filter shapes and a differing region", () => {
  for (const [label, ordered] of [
    ["id-tagged first", [body(ID_TAGGED, "NJ"), body(TYPE_TAGGED, "FL")]],
    ["type-tagged first", [body(TYPE_TAGGED, "FL"), body(ID_TAGGED, "NJ")]],
  ] as const) {
    it(`never reports a filters entry (${label})`, () => {
      const captures = ordered.map(cap);
      for (const [index, capture] of captures.entries()) {
        const frozen = findFrozenVaryingDrillParams(
          capture,
          JSON.stringify(ordered[index]),
          captures
        );
        expect(frozen.filter((entry) => JSON.stringify(entry).includes("filters"))).toEqual([]);
      }
    });

    it(`collectRequestBodyValuesByKey does not list filters (${label})`, () => {
      const captures = ordered.map(cap);
      for (const capture of captures) {
        expect(collectRequestBodyValuesByKey(capture, captures)!.has("filters")).toBe(false);
      }
    });
  }

  it("explains a differing region by the filter-array shape, but not when the shape is equal", () => {
    const shapeA = cap(body(ID_TAGGED, "NJ"));
    const shapeB = cap(body(TYPE_TAGGED, "FL"));
    const rendered = JSON.stringify(body(ID_TAGGED, "NJ"));
    expect(findFrozenVaryingDrillParams(shapeA, rendered, [shapeA, shapeB])).toEqual([]);
    const sameShape = cap(body(ID_TAGGED, "FL"));
    expect(
      findFrozenVaryingDrillParams(shapeA, rendered, [shapeA, sameShape]).map((entry) => entry.key)
    ).toEqual(["sorts.0.region"]);
  });

  it("still reports a genuinely varying unique-key value", () => {
    const a = cap({ ...body(ID_TAGGED, "NJ"), checkin: "2026-12-01" });
    const b = cap({ ...body(TYPE_TAGGED, "FL"), checkin: "2026-12-09" });
    expect(collectRequestBodyValuesByKey(a, [a, b])!.has("checkin")).toBe(true);
  });
});

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");
const OWN_BACKEND_HOST = "www.exclusive-shapes-sibling-fixture.example.com";
const DRILL_URL = `https://${OWN_BACKEND_HOST}/stays/rates/`;

function fixtureCaptures(regions: [string, string]): Capture[] {
  const primary = buildCapture({
    url: `https://${OWN_BACKEND_HOST}/stays/search/`,
    requestPostData: JSON.stringify({ page: 1 }),
    responseBody: { results: [{ hotel: "h-a" }, { hotel: "h-b" }, { hotel: "h-c" }] },
    timestamp: "2026-06-01T00:00:00.000Z",
  });
  const drill = (hotel: string, value: Record<string, unknown>, timestamp: string): Capture =>
    buildCapture({
      url: `${DRILL_URL}?hotel=${hotel}`,
      requestPostData: JSON.stringify(value),
      responseBody: { results: [{ hotel, amount: 120 }] },
      timestamp,
    });
  return [
    primary,
    drill("h-a", body(ID_TAGGED, regions[0]), "2026-06-01T00:00:01.000Z"),
    drill("h-b", body(ID_TAGGED.slice(0, 2), regions[0]), "2026-06-01T00:00:02.000Z"),
    drill("h-c", body(TYPE_TAGGED, regions[1]), "2026-06-01T00:00:03.000Z"),
  ];
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

function runGenerate(captures: Capture[]): { status: number | null; output: string } {
  workDir = mkdtempSync(join(tmpdir(), "barnacle-exclusive-sibling-"));
  const runRoot = join(workDir, "run");
  mkdirSync(join(runRoot, "graphql"), { recursive: true });
  mkdirSync(join(runRoot, "replays"), { recursive: true });
  mkdirSync(join(runRoot, "aux"), { recursive: true });
  writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
  captures.forEach((capture, index) => {
    writeFileSync(
      join(runRoot, "graphql", `${String(index).padStart(3, "0")}-capture.json`),
      JSON.stringify(capture)
    );
  });
  const siteId = `exclusive-sibling-test-${process.pid}`;
  siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({
      steps: [{ step: "search stays" }, { step: "drill into rates", submitStep: true }],
      submitEndpointPattern: "stays/rates",
      ownBackendHostnames: [OWN_BACKEND_HOST],
      foldReturn: { endpointPattern: "stays/rates", resultsPath: "results", joinFields: ["hotel"] },
    })
  );
  const result = spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

describe("recon-generate CLI — exclusive filter shapes with a sibling region", () => {
  it("generates contract.ts when the sibling region is constant", () => {
    const { status, output } = runGenerate(fixtureCaptures(["NJ", "NJ"]));
    expect(status, output).toBe(0);
    expect(output).not.toContain("would freeze a value that varied");
    expect(readFileSync(join(siteOutDir!, "contract.ts"), "utf8")).toContain("/stays/rates/");
  }, 60_000);

  it("never flags a filters.N slot when the sibling region differs", () => {
    const { status, output } = runGenerate(fixtureCaptures(["NJ", "FL"]));
    expect(status, output).toBe(0);
    expect(output).not.toContain("would freeze a value that varied");
    expect(output).not.toMatch(/body field \\?"filters\./);
  }, 60_000);
});
