import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins the report's defect 2: `payloadAccessorByValue`/`interpolateStateValues`
 * (recon-generate.ts:5299-5397, 5533-5635) bind a response-produced value into
 * a later request-body field by bare VALUE equality. A deeply-nested,
 * unrelated response scalar that merely happens to numerically/boolean-
 * coincide with a later, unrelated field's true value must never get spliced
 * into that field — it must either resolve from the correctly name-correlated
 * source or stay an unthreaded literal, never a coincidence-threaded one.
 *
 * The detail step's response carries one genuinely-reused field (`token`,
 * consumed downstream under the SAME name) alongside three unrelated, deeply
 * nested scalars whose values coincidentally equal three later, differently-
 * named submit-body fields: a pagination-like field, a party/quantity-like
 * field, and a boolean flag-like field.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.value-coincidence-threading-guard-fixture.example.com";
const LIST_URL = `https://${OWN_BACKEND_HOST}/catalog/search/`;
const DETAIL_URL = `https://${OWN_BACKEND_HOST}/catalog/detail/`;
const SUBMIT_URL = `https://${OWN_BACKEND_HOST}/catalog/submit/`;

// The genuinely-threaded value: same field name on both sides.
const TOKEN_VALUE = "tok9";

// The three deliberately-planted, unrelated-name value coincidences. Kept
// under recon-generate's MIN_STATE_VALUE_LENGTH (8) so the ONLY way any of
// them could thread is via the length-floor bypass that requires field-name
// correlation — exactly the guard under test.
const SORT_PRIORITY_VALUE = "42";
const STOCK_COUNT_VALUE = "17";
const BETA_FLAG_VALUE = "true";

function fixtureCaptures(): Capture[] {
  const list = buildCapture({
    url: LIST_URL,
    requestPostData: '{"page":1}',
    responseBody: { results: [{ itemId: "item-a" }] },
    timestamp: "2026-01-01T00:00:00Z",
  });
  const detail = buildCapture({
    url: DETAIL_URL,
    requestPostData: '{"itemId":"item-a"}',
    responseBody: {
      token: TOKEN_VALUE,
      meta: {
        display: { sortInfo: { priority: Number(SORT_PRIORITY_VALUE) } },
        inventory: { stock: { count: Number(STOCK_COUNT_VALUE) } },
        toggles: { betaFlag: BETA_FLAG_VALUE === "true" },
      },
    },
    timestamp: "2026-01-01T00:00:01Z",
  });
  // The submit body re-references `token` under its own genuine name, plus
  // three collision-shaped fields whose names have nothing to do with the
  // response fields their values coincidentally equal.
  const submit = buildCapture({
    url: SUBMIT_URL,
    requestPostData: JSON.stringify({
      itemId: "item-a",
      token: TOKEN_VALUE,
      resultPage: Number(SORT_PRIORITY_VALUE),
      partySize: Number(STOCK_COUNT_VALUE),
      wheelchairAccessible: BETA_FLAG_VALUE === "true",
    }),
    responseBody: { ok: true },
    timestamp: "2026-01-01T00:00:02Z",
  });
  return [list, detail, submit];
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

describe("recon-generate CLI — request-body fields never bind to a value-coincident, name-uncorrelated source", () => {
  it("sources each collision-shaped body field only from its own name-correlated accessor, never the unrelated-named local", () => {
    workDir = mkdtempSync(
      join(tmpdir(), "barnacle-body-field-value-coincidence-threading-guard-e2e-")
    );
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `body-field-value-coincidence-threading-guard-e2e-test-${process.pid}`;
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

    // Isolate the submit call's request-body template literal (the backtick
    // argument passed to `body:` on the line containing the submit URL),
    // mirroring how the partial-fix combined-verification-hooks test
    // extracts a template by regexing around `httpClient(`.
    const bodyLineMatch = contract.match(/catalog\/submit\/[\s\S]*?body:\s*`([^`]*)`/);
    expect(bodyLineMatch, contract).not.toBeNull();
    const bodyTemplate = bodyLineMatch![1]!;

    // The genuinely-threaded field must still resolve from its own
    // name-correlated accessor/local — the fix must not over-correct into
    // blocking legitimate same-name threading.
    const tokenLine = bodyTemplate.match(/"token"\s*:\s*"?\$\{([^}]*)\}"?/);
    expect(tokenLine, bodyTemplate).not.toBeNull();
    expect(tokenLine![1]).toMatch(/token/i);

    // The pagination-like field must never be sourced from the unrelated
    // sort-priority local (whose own derived name is "priority"-shaped, not
    // "resultPage"/"page"-shaped).
    const resultPageLine = bodyTemplate.match(/"resultPage"\s*:\s*"?([^,\n]*)"?/);
    if (resultPageLine && resultPageLine[1]!.includes("${")) {
      expect(resultPageLine[1]).not.toMatch(/priority/i);
    }

    // The party/quantity-like field must never be sourced from the unrelated
    // stock-count local.
    const partySizeLine = bodyTemplate.match(/"partySize"\s*:\s*"?([^,\n]*)"?/);
    if (partySizeLine && partySizeLine[1]!.includes("${")) {
      expect(partySizeLine[1]).not.toMatch(/count|stock/i);
    }

    // The boolean flag-like field must never be sourced from the unrelated
    // beta-toggle local.
    const wheelchairLine = bodyTemplate.match(/"wheelchairAccessible"\s*:\s*"?([^,\n]*)"?/);
    if (wheelchairLine && wheelchairLine[1]!.includes("${")) {
      expect(wheelchairLine[1]).not.toMatch(/beta/i);
    }

    // No invalidly-nested placeholder anywhere in the emitted body.
    expect(bodyTemplate).not.toMatch(/\$\{[^}]*\$\{/);
  }, 30_000);
});
