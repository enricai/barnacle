import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins the report's core new defect shape end to end through the CLI: a
 * value hoisted via a FIXED, constant array-index path into the PRIMARY
 * (search) capture's OWN response — not any loop item's own object — that
 * therefore stays byte-identical across every fold-loop iteration. That
 * frozen local coincidentally equals the TRUE literal values of TWO
 * differently-named later drill-body fields simultaneously (a
 * pagination-like field, `filters.page`, and a party/count-like field,
 * `filters.adultCount`), recorded on item-a's drill capture. Unlike
 * `recon-generate-1-12-50-loop-scoped-drill-value-multi-target-threading-guard-e2e.test.ts`
 * (whose coincidental local lives on the loop ITEM's own object and differs
 * per item), the frozen value here lives at a literal `["3"]` index into an
 * unrelated `meta.catalogInfo` map on the PRIMARY response, has no
 * corresponding field on either item at all, and would (if threaded) splice
 * into the fold-loop body on EVERY iteration identically, not just item-a's.
 *
 * Post-fix, `filters` is emitted as a single whole-object `payload.filters`
 * accessor — the frozen, unrelated primary-response value never reaches
 * either field. A genuinely same-named reused field (`detailToken`) must
 * still resolve.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST =
  "www.primary-capture-frozen-index-multi-target-threading-guard-fixture.example.com";
const LIST_URL = `https://${OWN_BACKEND_HOST}/catalog/search/`;
const DETAIL_URL = `https://${OWN_BACKEND_HOST}/catalog/detail/`;
const SUBMIT_URL = `https://${OWN_BACKEND_HOST}/catalog/submit/`;

// The genuinely-reused value: same field name on both sides.
const DETAIL_TOKEN_VALUE = "detail-token-item-a";

// A constant read from a FIXED literal index into the PRIMARY capture's own
// response, unrelated to either loop item's own fields — chosen with no
// digit overlap with any other state value in this fixture so no unrelated
// substring match can interfere with the assertion.
const FROZEN_PRIMARY_INDEX_VALUE = 619;

function fixtureCaptures(): Capture[] {
  const list = buildCapture({
    url: LIST_URL,
    requestPostData: JSON.stringify({ resultPage: 1 }),
    responseBody: {
      results: [{ itemId: "item-a" }, { itemId: "item-b" }],
      // A map keyed by a literal string index, several levels deep, that is
      // NOT part of either loop item's own object — a fixed accessor into
      // the primary response, read once before the loop starts.
      meta: {
        catalogInfo: {
          "3": { tierInfo: { tierInfo: FROZEN_PRIMARY_INDEX_VALUE } },
        },
      },
    },
    timestamp: "2026-01-01T00:00:00Z",
  });
  // Only ONE per-item drill call is ever recorded (item-a) — the fold plan
  // must synthesize the rest from item data. `filters.page` and
  // `filters.adultCount` are two DIFFERENTLY-NAMED nested fields whose
  // recorded literal coincidentally equals the frozen primary-response
  // index value, not anything on item-a's own object.
  const detailA = buildCapture({
    url: DETAIL_URL,
    requestPostData: JSON.stringify({
      itemId: "item-a",
      filters: { page: FROZEN_PRIMARY_INDEX_VALUE, adultCount: FROZEN_PRIMARY_INDEX_VALUE },
    }),
    responseBody: { detailToken: DETAIL_TOKEN_VALUE, itemId: "item-a" },
    timestamp: "2026-01-01T00:00:01Z",
  });
  const submit = buildCapture({
    url: SUBMIT_URL,
    requestPostData: JSON.stringify({ itemId: "item-a", detailToken: DETAIL_TOKEN_VALUE }),
    responseBody: { ok: true },
    timestamp: "2026-01-01T00:00:02Z",
  });
  return [list, detailA, submit];
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

describe("recon-generate CLI — a value frozen at a fixed index into the primary capture's own response never threads into fold-loop body fields", () => {
  it("never sources the fold-loop drill body from the frozen primary-response accessor, and still resolves a genuinely same-named reused field", () => {
    workDir = mkdtempSync(
      join(tmpdir(), "barnacle-primary-capture-frozen-index-multi-target-threading-guard-e2e-")
    );
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `primary-capture-frozen-index-multi-target-threading-guard-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "browse catalog search" },
          { step: "open item detail panel" },
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

    // A genuine per-item ancestor for-loop drill, not a hardcoded per-item
    // call — proves the fixture actually exercises the fold/drill-loop path.
    expect(contract).toMatch(/for\s*\(const \w+ of \w+\)/);

    // Isolate the per-item drill call's request-body template literal.
    const drillBodyMatch = contract.match(/catalog\/detail\/[\s\S]*?body:\s*`([^`]*)`/);
    expect(drillBodyMatch, contract).not.toBeNull();
    const drillBodyTemplate = drillBodyMatch![1]!;

    // Neither the pagination-like field nor the party/count-like field may be
    // sourced from the frozen, fixed-index primary-response accessor — the
    // report's core new defect was ONE call-level constant threading into
    // BOTH simultaneously, on every loop iteration. Assert over the whole
    // drill body template (not per-key) since the fix may legitimately
    // re-emit `filters` as a single whole-object accessor.
    expect(drillBodyTemplate).not.toMatch(/tierinfo/i);
    expect(drillBodyTemplate).not.toMatch(/catalogInfo/i);

    // The genuinely-threaded field must still resolve from its own
    // name-correlated accessor/local — the fix must not over-correct into
    // blocking legitimate same-name threading.
    const submitBodyMatch = contract.match(/catalog\/submit\/[\s\S]*?body:\s*`([^`]*)`/);
    expect(submitBodyMatch, contract).not.toBeNull();
    const submitBodyTemplate = submitBodyMatch![1]!;
    const detailTokenLine = submitBodyTemplate.match(/"detailToken"\s*:\s*"?\$\{([^}]*)\}"?/);
    expect(detailTokenLine, submitBodyTemplate).not.toBeNull();
    expect(detailTokenLine![1]).toMatch(/detailtoken/i);

    // No invalidly-nested placeholder anywhere in either emitted body.
    expect(drillBodyTemplate).not.toMatch(/\$\{[^}]*\$\{/);
    expect(submitBodyTemplate).not.toMatch(/\$\{[^}]*\$\{/);
  }, 60_000);
});
