import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins the report's core failure shape end to end through the CLI: a
 * per-item ancestor for-loop drill (a genuine multi-item fold loop, only
 * ONE per-item drill call is ever recorded — the fold plan must synthesize
 * the rest from item data, exactly how the report's real interaction was
 * captured) whose PRIMARY (search) response nests one unrelated scalar 4+
 * levels deep behind a composite bracket-string key
 * (`meta.ranking.groups["0"].entries["0"].facet["sort-variant"].sortInfo
 * .sortInfo`). That single loop-scoped local's value coincidentally equals
 * the TRUE literal values of TWO differently-named later drill-body fields
 * simultaneously — a pagination-like field (`filters.page`) and a
 * party/count-like field (`filters.adultCount`) — recorded on the SAME
 * drill capture, mirroring the report's real-world `displayOrder` local
 * wrongly threading into both `page` and `exploreMorePage` on the same
 * per-item drill request.
 *
 * Confirmed via this exact fixture against the pre-fix
 * `findThreadedJoinFields` (recon-generate.ts, `fix: gate
 * findThreadedJoinFields body-value threading on name correlation`): both
 * `filters.page` and `filters.adultCount` were spliced verbatim from the
 * item's unrelated `...sortInfo.sortInfo` accessor. Post-fix, `filters` is
 * emitted as a single `payload.filters` accessor (the whole recorded object,
 * unmodified) — the coincidental value never reaches either field via the
 * unrelated local. A genuinely same-named reused field (`detailToken`) must
 * still resolve.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.loop-scoped-drill-multi-target-threading-guard-fixture.example.com";
const LIST_URL = `https://${OWN_BACKEND_HOST}/catalog/search/`;
const DETAIL_URL = `https://${OWN_BACKEND_HOST}/catalog/detail/`;
const SUBMIT_URL = `https://${OWN_BACKEND_HOST}/catalog/submit/`;

// The genuinely-reused value: same field name on both sides.
const DETAIL_TOKEN_VALUE = "detail-token-item-a";

// The loop-scoped, deeply-nested (4+ levels, composite bracket-string keys)
// value that coincidentally equals TWO differently-named drill-body fields'
// own true literals simultaneously, on item-a (the only item with a
// recorded drill call). Chosen with no digit overlap with any other state
// value in this fixture (e.g. `resultPage`) so no unrelated substring match
// can interfere with the assertion. item-b's own value differs, proving the
// local is genuinely item-scoped rather than a frozen literal.
const SORT_INFO_VALUE_A = 733;
const SORT_INFO_VALUE_B = 844;

function deepSortInfo(value: number): Record<string, unknown> {
  return {
    groups: {
      "0": {
        entries: {
          "0": {
            facet: {
              "sort-variant": {
                sortInfo: { sortInfo: value },
              },
            },
          },
        },
      },
    },
  };
}

function fixtureCaptures(): Capture[] {
  const list = buildCapture({
    url: LIST_URL,
    requestPostData: JSON.stringify({ resultPage: 1 }),
    responseBody: {
      results: [
        { itemId: "item-a", meta: { ranking: deepSortInfo(SORT_INFO_VALUE_A) } },
        { itemId: "item-b", meta: { ranking: deepSortInfo(SORT_INFO_VALUE_B) } },
      ],
    },
    timestamp: "2026-01-01T00:00:00Z",
  });
  // Only ONE per-item drill call is ever recorded (item-a) — the real
  // interaction this fold plan is built from. `filters.page` and
  // `filters.adultCount` are two DIFFERENTLY-NAMED nested fields whose
  // recorded literal (733) coincidentally equals item-a's own deep,
  // unrelated `meta.ranking...sortInfo.sortInfo` local.
  const detailA = buildCapture({
    url: DETAIL_URL,
    requestPostData: JSON.stringify({
      itemId: "item-a",
      filters: { page: SORT_INFO_VALUE_A, adultCount: SORT_INFO_VALUE_A },
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

describe("recon-generate CLI — one loop-scoped drill value never threads into two differently-named drill-body fields", () => {
  it("never sources the drill-loop body from the unrelated loop-scoped local, and still resolves a genuinely same-named reused field", () => {
    workDir = mkdtempSync(
      join(tmpdir(), "barnacle-loop-scoped-drill-multi-target-threading-guard-e2e-")
    );
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `loop-scoped-drill-multi-target-threading-guard-e2e-test-${process.pid}`;
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
    // sourced from the unrelated, loop-scoped `sortInfo` local — the report's
    // core defect was ONE local threading into BOTH simultaneously. Assert
    // over the whole drill body template (not per-key) since the fix may
    // legitimately re-emit `filters` as a single whole-object accessor.
    expect(drillBodyTemplate).not.toMatch(/sortinfo/i);
    expect(drillBodyTemplate).not.toMatch(/groups|entries|facet|ranking/i);

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
