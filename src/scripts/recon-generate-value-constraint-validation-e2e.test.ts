import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Proves recon-generate emits caller-facing value constraints derived purely
 * from observed capture SHAPE, not from any select-sourced (OPT_<Name>)
 * dropdown or site-specific field name:
 *
 * - a request field whose distinct values across the run's captures form a
 *   small closed set (a facet, e.g. a room/plan-type selector never exposed
 *   as an HTML <select>) gets a z.enum(...) rather than a bare z.string();
 * - a numeric field paired with a same-run response's max/capacity/limit-
 *   shaped ceiling gets a bounded z.number().max(...) rather than an
 *   unconstrained z.number().
 *
 * Runs the real CLI end to end, then loads the emitted PayloadSchema with a
 * real zod instance and calls safeParse — proving the constraint actually
 * rejects an out-of-set/over-capacity caller value while still accepting
 * every value the fixture itself observed.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.value-constraint-validation-fixture.example.com";
const SEARCH_URL = `https://${OWN_BACKEND_HOST}/lodging/search/`;
const HOLD_URL = `https://${OWN_BACKEND_HOST}/lodging/hold/`;
const CONFIRM_URL = `https://${OWN_BACKEND_HOST}/lodging/confirm/`;

function fixtureCaptures(): Capture[] {
  const search = buildCapture({
    url: SEARCH_URL,
    requestPostData: JSON.stringify({ query: "lakeside" }),
    responseBody: { results: [{ unitId: "unit-a" }] },
    timestamp: "2026-05-01T00:00:00Z",
  });
  // Distinct unitPlan values across the two non-entry captures form a
  // closed, small set — a facet vocabulary never sourced from an HTML
  // <select> (no formSchema/OPT_ involved anywhere in this fixture).
  const hold = buildCapture({
    url: HOLD_URL,
    requestPostData: JSON.stringify({ unitId: "unit-a", unitPlan: "Standard", partySize: 2 }),
    responseBody: { held: true },
    timestamp: "2026-05-01T00:00:01Z",
  });
  // The confirm response carries a capacity ceiling (partyCapacityLimit) —
  // structurally shaped (matches /max|capacity|limit/i), not any hardcoded
  // domain field name — that is >= every observed partySize.
  const confirm = buildCapture({
    url: CONFIRM_URL,
    requestPostData: JSON.stringify({ unitId: "unit-a", unitPlan: "Deluxe", partySize: 3 }),
    responseBody: { confirmed: true, partyCapacityLimit: 4 },
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

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate CLI — vocabulary-derived enum and capacity-bounded number on non-select fields", () => {
  it("emits z.enum(...) for a closed-set facet field and a bounded z.number() for a capacity-paired numeric field", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-value-constraint-validation-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `value-constraint-validation-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
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

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // Facet field: closed set observed across captures -> z.enum(...), never
    // a bare z.string().
    expect(contract).toMatch(/unitPlan:\s*z\.enum\(\[[^\]]*\]\),/);
    expect(contract).not.toMatch(/unitPlan:\s*z\.string\(\),/);

    // Capacity-bounded numeric field: bounded by the response-declared
    // ceiling, never an unconstrained z.number().
    expect(contract).toMatch(/partySize:\s*z\.number\(\)\.max\(4\),/);
    expect(contract).not.toMatch(/partySize:\s*z\.number\(\),/);

    // Load the real emitted PayloadSchema with a real zod instance and prove
    // the constraint is enforced at parse time, not merely present as text.
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

    // Every value actually observed in the fixture still parses.
    expect(
      PayloadSchema.safeParse({ ...BASE_VALID_PAYLOAD, unitPlan: "Standard", partySize: 2 }).success
    ).toBe(true);
    expect(
      PayloadSchema.safeParse({ ...BASE_VALID_PAYLOAD, unitPlan: "Deluxe", partySize: 3 }).success
    ).toBe(true);

    // An unlisted facet value is rejected.
    expect(
      PayloadSchema.safeParse({
        ...BASE_VALID_PAYLOAD,
        unitPlan: "PresidentialSuite",
        partySize: 2,
      }).success
    ).toBe(false);

    // An over-capacity numeric value is rejected.
    expect(
      PayloadSchema.safeParse({
        ...BASE_VALID_PAYLOAD,
        unitPlan: "Standard",
        partySize: 99,
      }).success
    ).toBe(false);
  }, 30_000);
});
