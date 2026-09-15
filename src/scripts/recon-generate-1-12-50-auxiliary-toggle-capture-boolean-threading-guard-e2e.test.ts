import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins the report's "Minor residual" case: an auxiliary, out-of-flow
 * feature-toggle read (mirroring `toggles/product-avail`) that is NOT one of
 * the recon-flow.json `steps` entries still lands in the capture pool and
 * still clears `extractActionSequence`'s structural gates (own-backend host,
 * 2xx, non-noise). Its response carries two boolean fields under names that
 * have nothing to do with two later, differently-named submit-body boolean
 * fields, whose true values coincidentally match. Being outside the declared
 * step sequence must not create a second, unguarded threading path — the
 * SAME name-correlation gate compileActionSteps applies to declared-step
 * captures must apply to this one too, since the gate scans `actionCaptures`
 * structurally and never consults the flow's own step descriptions.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.auxiliary-toggle-threading-guard-fixture.example.com";
const LIST_URL = `https://${OWN_BACKEND_HOST}/catalog/search/`;
// Compound-segment paths sharing the "item" token with the toggle read below
// — this is what keeps the auxiliary capture out of extractActionSequence's
// structural-isolation exclusion (recon/capture-filters.ts's
// isStructurallyIsolatedCapture) and into actionCaptures, so
// compileActionSteps' name-correlation gate — not an unrelated upstream
// filter — is what this test actually exercises.
const DETAIL_URL = `https://${OWN_BACKEND_HOST}/catalog/item-detail-info/`;
const TOGGLES_URL = `https://${OWN_BACKEND_HOST}/toggles/item-avail-flags/`;
const SUBMIT_URL = `https://${OWN_BACKEND_HOST}/catalog/item-submit-flow/`;

// The genuinely-threaded value: same field name on both sides.
const TOKEN_VALUE = "tok9";

// The two auxiliary toggle-read booleans whose values coincidentally equal
// two later, differently-named submit-body booleans. Booleans stringify
// below MIN_STATE_VALUE_LENGTH (8), so the only way either could thread at
// all is via the name-correlation exemption path this pins.
const SPECIAL_OFFER_TOGGLE_VALUE = true;
const LOCALE_STORAGE_TOGGLE_VALUE = false;

function fixtureCaptures(): Capture[] {
  const list = buildCapture({
    url: LIST_URL,
    requestPostData: '{"page":1}',
    responseBody: { results: [{ itemId: "item-a" }] },
    timestamp: "2026-01-01T00:00:00Z",
  });
  // Auxiliary out-of-flow capture: not described by any recon-flow.json
  // `steps` entry, but still a same-host 2xx call extractActionSequence's
  // structural gates admit on their own merits.
  const toggles = buildCapture({
    url: TOGGLES_URL,
    requestPostData: "[]",
    responseBody: {
      dclSpecialOfferRefactor: SPECIAL_OFFER_TOGGLE_VALUE,
      enableHomepageLocaleStorage: LOCALE_STORAGE_TOGGLE_VALUE,
    },
    timestamp: "2026-01-01T00:00:01Z",
  });
  const detail = buildCapture({
    url: DETAIL_URL,
    requestPostData: '{"itemId":"item-a"}',
    responseBody: { token: TOKEN_VALUE },
    timestamp: "2026-01-01T00:00:02Z",
  });
  // The submit body re-references `token` under its own genuine name, plus
  // two collision-shaped fields whose names have nothing to do with the
  // auxiliary toggle read's own field names their values coincidentally
  // equal.
  const submit = buildCapture({
    url: SUBMIT_URL,
    requestPostData: JSON.stringify({
      itemId: "item-a",
      token: TOKEN_VALUE,
      accessible: SPECIAL_OFFER_TOGGLE_VALUE,
      includeAdvancedBookingPrices: LOCALE_STORAGE_TOGGLE_VALUE,
    }),
    responseBody: { ok: true },
    timestamp: "2026-01-01T00:00:03Z",
  });
  return [list, toggles, detail, submit];
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

describe("recon-generate CLI — an auxiliary out-of-flow toggle capture never sources unrelated submit-body booleans", () => {
  it("never splices the auxiliary capture's own-named booleans into differently-named submit-body fields", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-auxiliary-toggle-threading-guard-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `auxiliary-toggle-threading-guard-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    // Deliberately only 3 declared steps for 4 captures — the toggle read has
    // no step entry of its own, mirroring an auxiliary page-load capture
    // that recon never asked the user to narrate.
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "browse catalog search" },
          { step: "open item detail panel" },
          { step: "submit item selection", submitStep: true },
        ],
        submitEndpointPattern: "catalog/item-submit-flow",
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

    const bodyLineMatch = contract.match(/catalog\/item-submit-flow\/[\s\S]*?body:\s*`([^`]*)`/);
    expect(bodyLineMatch, contract).not.toBeNull();
    const bodyTemplate = bodyLineMatch![1]!;

    // The genuinely-threaded field must still resolve from its own
    // name-correlated accessor/local — the fix must not over-correct into
    // blocking legitimate same-name threading.
    const tokenLine = bodyTemplate.match(/"token"\s*:\s*"?\$\{([^}]*)\}"?/);
    expect(tokenLine, bodyTemplate).not.toBeNull();
    expect(tokenLine![1]).toMatch(/token/i);

    // Non-vacuity check: the auxiliary toggle read must actually have
    // survived extractActionSequence's structural-isolation gate and be
    // emitted as its own httpClient call — otherwise the guard below would
    // pass trivially because compileActionSteps never even saw its fields.
    expect(contract).toMatch(/toggles\/item-avail-flags/);

    // Neither collision-shaped field may be sourced from the auxiliary
    // capture's own-named local — its own derived names ("specialOffer"/
    // "special", "localeStorage"/"locale"/"homepage") have nothing to do
    // with "accessible"/"includeAdvancedBookingPrices".
    const accessibleLine = bodyTemplate.match(/"accessible"\s*:\s*"?([^,\n}]*)"?/);
    if (accessibleLine && accessibleLine[1]!.includes("${")) {
      expect(accessibleLine[1]).not.toMatch(/special|offer/i);
    }
    const advBookingLine = bodyTemplate.match(
      /"includeAdvancedBookingPrices"\s*:\s*"?([^,\n}]*)"?/
    );
    if (advBookingLine && advBookingLine[1]!.includes("${")) {
      expect(advBookingLine[1]).not.toMatch(/locale|homepage/i);
    }

    // No invalidly-nested placeholder anywhere in the emitted body.
    expect(bodyTemplate).not.toMatch(/\$\{[^}]*\$\{/);

    // Coherence check: whether or not the auxiliary toggle capture itself
    // survives into the emitted contract as its own httpClient call, its
    // own response field names must never leak as an interpolation source
    // ANYWHERE in the file — not just inside the submit body template. An
    // auxiliary capture that IS emitted but whose fields are unused, or one
    // that is dropped entirely, are both coherent outcomes; a splice of its
    // field names into an unrelated interpolation is not.
    expect(contract).not.toMatch(/\$\{[^}]*dclSpecialOfferRefactor[^}]*\}/i);
    expect(contract).not.toMatch(/\$\{[^}]*enableHomepageLocaleStorage[^}]*\}/i);
  }, 30_000);
});
