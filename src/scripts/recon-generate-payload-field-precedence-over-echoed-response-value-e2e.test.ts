import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins the reported currency-exception defect: `interpolateStateValues`
 * (recon-generate.ts:5003-5038) builds `bindingByValue` by writing the
 * `payloadAccessorByValue` entries first, then unconditionally overwriting
 * any of them with `stateBindings` entries for the same literal value. A
 * field that is already caller-supplied on the flow's first request body
 * loses its `payload.<field>` accessor the moment an intervening step's
 * response happens to echo that same literal value under the same field
 * name — every OTHER call in the same `executeHttp` then wrongly sources
 * that field from the scraped/produced local instead of the payload.
 *
 * The first call's own body carries the caller-supplied field. The second
 * call's response echoes the identical value under the same field name —
 * but the second call's OWN request body never carries that field, so this
 * is a coincidental echo, not a producer-boundary coordinate (see
 * recon-generate-producer-boundary.test.ts, which locks the opposite,
 * deliberate case: a value a step both sends AND echoes threads the state
 * var on every call after that producer). The third call re-submits the
 * field and must resolve it to `payload.<field>`, never the echoed local.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.payload-field-precedence-fixture.example.com";
const LIST_URL = `https://${OWN_BACKEND_HOST}/catalog/search/`;
const DETAIL_URL = `https://${OWN_BACKEND_HOST}/catalog/detail/`;
const SUBMIT_URL = `https://${OWN_BACKEND_HOST}/catalog/submit/`;

// Kept >= MIN_STATE_VALUE_LENGTH (8) so it clears the state-threading
// eligibility floor on its own merits, and given the SAME field name on
// both sides so it also clears the name-correlation guard — exactly the
// coincidence the report's defect requires to reproduce.
const MEASUREMENT_UNIT_VALUE = "kilograms-500";

function fixtureCaptures(): Capture[] {
  const list = buildCapture({
    url: LIST_URL,
    requestPostData: JSON.stringify({ page: 1, measurementUnit: MEASUREMENT_UNIT_VALUE }),
    responseBody: { results: [{ itemId: "item-a" }] },
    timestamp: "2026-01-01T00:00:00Z",
  });
  // The detail step's OWN request body never carries measurementUnit — only
  // its response echoes it — so this is a coincidental echo, not a
  // producer-boundary coordinate (deriveProducerBoundaryBindings requires the
  // producing step to re-send the value in its own body; see
  // recon-generate-producer-boundary.test.ts's "does not bind a produced
  // value that is NOT re-sent in its own producer body"). That distinction is
  // exactly what must not collapse the payload precedence fixed here.
  const detail = buildCapture({
    url: DETAIL_URL,
    requestPostData: JSON.stringify({ itemId: "item-a" }),
    responseBody: {
      conversion: { summary: { measurementUnit: MEASUREMENT_UNIT_VALUE } },
    },
    timestamp: "2026-01-01T00:00:01Z",
  });
  const submit = buildCapture({
    url: SUBMIT_URL,
    requestPostData: JSON.stringify({ itemId: "item-a", measurementUnit: MEASUREMENT_UNIT_VALUE }),
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

describe("recon-generate CLI — payload-sourced body fields outrank a coincidentally value-echoing response local", () => {
  it("sources every occurrence of a caller-supplied field from payload.<field>, never the value-echoing scraped local", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-payload-field-precedence-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `payload-field-precedence-e2e-test-${process.pid}`;
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

    // Isolate the submit call's request-body template literal by anchoring on
    // its own URL, mirroring the sibling coincidence-threading-guard e2e test.
    // The detail step's own body never carries measurementUnit (see
    // fixtureCaptures), so only submit's re-send of the field is at risk.
    const submitBodyMatch = contract.match(/catalog\/submit\/[\s\S]*?body:\s*`([^`]*)`/);
    expect(submitBodyMatch, contract).not.toBeNull();
    const submitBodyTemplate = submitBodyMatch![1]!;

    // The caller-supplied field must resolve to `payload.measurementUnit` —
    // never the scraped/produced local — even though the detail step's
    // response echoes the identical value under the identical field name.
    const submitFieldLine = submitBodyTemplate.match(/"measurementUnit"\s*:\s*"?\$\{([^}]*)\}"?/);
    expect(submitFieldLine, submitBodyTemplate).not.toBeNull();
    expect(submitFieldLine![1]).toBe("payload.measurementUnit");

    // No invalidly-nested placeholder anywhere in the emitted body.
    expect(submitBodyTemplate).not.toMatch(/\$\{[^}]*\$\{/);
  }, 30_000);
});
