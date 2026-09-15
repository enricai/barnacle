import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins a narrower edge case of the value-coincidence name-correlation guard:
 * when a value is reached through an object key that is itself a composite,
 * semicolon-delimited string (e.g. `categories['DD-INSIDE;entityType=stateroom-
 * type;destination=dcl'].displayOrder`) rather than a simple identifier, the
 * correlation check must derive the candidate's "own name" from the innermost
 * real property name in the access chain (`displayOrder`), never from the
 * noisy composite key text. Otherwise a request-body field whose name happens
 * to textually resemble fragments of the composite key (or whose value merely
 * coincides) could get incorrectly threaded from that unrelated accessor.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.composite-key-name-correlation-fixture.example.com";
const LIST_URL = `https://${OWN_BACKEND_HOST}/catalog/search/`;
const DETAIL_URL = `https://${OWN_BACKEND_HOST}/catalog/detail/`;
const SUBMIT_URL = `https://${OWN_BACKEND_HOST}/catalog/submit/`;

// The composite, semicolon-delimited object key wrapping the innermost real
// property name (`displayOrder`). Kept structurally identical to the
// reported shape so its punctuation can't be mistaken for a real identifier.
const COMPOSITE_KEY = "DD-INSIDE;entityType=stateroom-type;destination=dcl";

// Kept short (< MIN_STATE_VALUE_LENGTH) so the ONLY way this value could
// thread into an unrelated field is via a broken name-derivation that reads
// the composite key text instead of the innermost "displayOrder" name.
const DISPLAY_ORDER_VALUE = "3";

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
      categories: {
        [COMPOSITE_KEY]: { displayOrder: Number(DISPLAY_ORDER_VALUE) },
      },
    },
    timestamp: "2026-01-01T00:00:01Z",
  });
  // The submit body carries a field whose own name has nothing to do with
  // "displayOrder" but whose true value coincidentally equals it — and whose
  // name also happens to overlap textually with fragments of the composite
  // key ("destination"), which a broken name-derivation could mistake for a
  // correlation signal.
  const submit = buildCapture({
    url: SUBMIT_URL,
    requestPostData: JSON.stringify({
      itemId: "item-a",
      destination: Number(DISPLAY_ORDER_VALUE),
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

describe("recon-generate CLI — composite-keyed accessors derive their own name from the innermost property, not the composite key text", () => {
  it("never sources an unrelated body field from a value reached via a semicolon-delimited composite key whose innermost name doesn't match", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-composite-key-name-correlation-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `composite-key-name-correlation-e2e-test-${process.pid}`;
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

    const bodyLineMatch = contract.match(/catalog\/submit\/[\s\S]*?body:\s*`([^`]*)`/);
    expect(bodyLineMatch, contract).not.toBeNull();
    const bodyTemplate = bodyLineMatch![1]!;

    // The unrelated "destination" field must never be sourced from the
    // composite-keyed "displayOrder" accessor — neither via the raw
    // composite key text nor via the value's coincidental match.
    const destinationLine = bodyTemplate.match(/"destination"\s*:\s*"?([^,\n}]*)"?/);
    if (destinationLine && destinationLine[1]!.includes("${")) {
      expect(destinationLine[1]).not.toMatch(/displayorder/i);
      expect(destinationLine[1]).not.toMatch(/dd-inside|stateroom|destination=dcl/i);
    }

    // No invalidly-nested placeholder anywhere in the emitted body.
    expect(bodyTemplate).not.toMatch(/\$\{[^}]*\$\{/);
  }, 30_000);
});
