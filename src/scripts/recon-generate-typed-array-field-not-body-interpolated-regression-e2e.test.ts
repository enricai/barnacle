import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { multipartJsonObject } from "@/lib/zod-multipart";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins Finding 1's array half: a flow-declared, schema-required
 * array-of-objects payload field (a party/quantity breakdown, mirroring
 * `{typeId, count}` pairs) whose captured value repeats verbatim across
 * every action-step request body of a multi-step browse/search flow must be
 * emitted as `${JSON.stringify(payload.<field>)}` in every occurrence — the
 * same substitution shape `applyStructuredValuePayloadSubstitutions` already
 * uses for sibling structured fields elsewhere in this file — never left as
 * a frozen literal (which the sibling scalar-field defect pinned by
 * test-001 also reports, but bare `${payload.<field>}` interpolation would
 * additionally be wrong here since it would splice `[object Object]` into a
 * JSON body).
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.typed-array-field-interpolation-regression-fixture.example.com";
const BROWSE_URL = `https://${OWN_BACKEND_HOST}/catalog/browse/`;
const REFINE_URL = `https://${OWN_BACKEND_HOST}/catalog/refine/`;
const SUBMIT_URL = `https://${OWN_BACKEND_HOST}/catalog/submit/`;

// The flow-declared array-of-objects value, repeated verbatim in every
// step's request body — mirrors a captured quantity/id breakdown.
const QUANTITY_MIX = [
  { typeId: 1, count: 2 },
  { typeId: 2, count: 1 },
];

// An already-correctly-wired sibling scalar control field, present in every
// body alongside the array field, to prove the fix doesn't regress scalar
// threading.
const REGION_VALUE = "north-america-east-1";

// A nested object with more primitive fields than the body root, so
// `locateFormEnvelopePath`'s heuristic outranks the root and picks THIS
// object as the "form envelope" — leaving the root-level array field
// (quantityMix) a sibling of the envelope, not a child of it, which is
// exactly the shape that skipped every substitution pass before the fix.
const FILTERS = { page: 1, size: 20, sort: "asc", order: "desc" };

function fixtureCaptures(): Capture[] {
  const browse = buildCapture({
    url: BROWSE_URL,
    requestPostData: JSON.stringify({
      quantityMix: QUANTITY_MIX,
      region: REGION_VALUE,
      filters: FILTERS,
    }),
    responseBody: { results: [{ itemId: "item-a" }] },
    timestamp: "2026-01-01T00:00:00Z",
  });
  const refine = buildCapture({
    url: REFINE_URL,
    requestPostData: JSON.stringify({
      quantityMix: QUANTITY_MIX,
      region: REGION_VALUE,
      filters: FILTERS,
    }),
    responseBody: { results: [{ itemId: "item-a" }] },
    timestamp: "2026-01-01T00:00:01Z",
  });
  const submit = buildCapture({
    url: SUBMIT_URL,
    requestPostData: JSON.stringify({
      itemId: "item-a",
      quantityMix: QUANTITY_MIX,
      region: REGION_VALUE,
      filters: FILTERS,
    }),
    responseBody: { ok: true },
    timestamp: "2026-01-01T00:00:02Z",
  });
  return [browse, refine, submit];
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

/**
 * Reads the generated contract.ts's `const <Pascal>PayloadSchema = ...`
 * expression back out and evaluates it against the real `zod/v4` runtime,
 * mirroring recon-generate-declared-filter-unwired-warn.test.ts's approach.
 */
function readPayloadSchema(dir: string): ReturnType<typeof z.object> {
  const contract = readFileSync(join(dir, "contract.ts"), "utf8");
  const match = /const \w+PayloadSchema = ([\s\S]*?);\n/.exec(contract);
  if (!match) throw new Error(`no PayloadSchema declaration found in ${contract}`);
  return new Function("z", "multipartJsonObject", `return ${match[1]};`)(z, multipartJsonObject);
}

describe("recon-generate CLI — flow-declared typed array field threaded into every request body", () => {
  it("splices JSON.stringify(payload.quantityMix) into every occurrence and declares it as a non-optional typed array", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-typed-array-field-interpolation-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `typed-array-field-interpolation-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "browse catalog" },
          { step: "refine catalog search" },
          { step: "submit item selection", submitStep: true },
        ],
        submitEndpointPattern: "catalog/submit",
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

    // Every request-body template literal that carries the field must
    // splice it via JSON.stringify(payload.quantityMix), not bare
    // interpolation and not the frozen literal.
    const bodyBlocks = [...contract.matchAll(/body:\s*`([^`]*)`/g)].map((m) => m[1]!);
    const bodiesWithField = bodyBlocks.filter((body) => body.includes("quantityMix"));
    expect(bodiesWithField.length).toBeGreaterThanOrEqual(3);
    for (const body of bodiesWithField) {
      expect(body).toContain("JSON.stringify(payload.quantityMix)");
    }

    // Zero occurrences of the raw captured array literal remain anywhere in
    // any request body.
    for (const body of bodyBlocks) {
      expect(body).not.toMatch(/"typeId"\s*:\s*1/);
      expect(body).not.toMatch(/"typeId"\s*:\s*2/);
    }

    // The already-wired sibling scalar control field must still resolve
    // from its own accessor — the fix must not regress scalar threading.
    for (const body of bodiesWithField) {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
      expect(body).toContain("${payload.region}");
      expect(body).not.toContain(REGION_VALUE);
    }

    // The emitted PayloadSchema declares quantityMix as a non-optional
    // typed array (z.array(z.object(...)) or equivalent inference).
    const bodySchema = readPayloadSchema(siteOutDir!);
    const baseValidPayload = {
      BaseUrl: `https://${OWN_BACKEND_HOST}`,
      itemId: "item-a",
      region: REGION_VALUE,
      filters: FILTERS,
    };
    expect(bodySchema.safeParse({ ...baseValidPayload, quantityMix: QUANTITY_MIX }).success).toBe(
      true
    );
    expect(bodySchema.safeParse(baseValidPayload).success).toBe(false);
    expect(bodySchema.safeParse({ ...baseValidPayload, quantityMix: "not-an-array" }).success).toBe(
      false
    );
  }, 30_000);
});
