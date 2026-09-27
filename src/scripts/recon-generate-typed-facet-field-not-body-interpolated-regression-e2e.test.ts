import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins Finding 1's scalar half: a flow-declared, schema-required string
 * payload field (mirroring the report's ship/departurePort/sailMonth/theme/
 * privateIsland facets) whose captured value repeats verbatim across EVERY
 * action-step request body must be emitted as `${payload.<Field>}` in every
 * one of those occurrences, exactly like the adjacent, already-correctly-
 * wired `filters` field in the same bodies — not validated as required and
 * then functionally discarded as a frozen literal.
 *
 * Exercises the real CLI end to end (tsx recon-generate.ts) against a
 * multi-step (3 action steps) fixture whose facet-selection step declares
 * `payloadField` on the captured `region` field, so it is schema-required
 * exactly like the reported facets. The captured value is repeated as its
 * own exact top-level key on every step AND spliced inside a differently-
 * keyed `filters` facet-filter string on the final step, mirroring both
 * threading mechanisms the report and its unit-level regression siblings
 * cover, now proven end to end through the generated contract.ts.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.facet-field-not-body-interpolated-regression-fixture.example.com";
const LIST_URL = `https://${OWN_BACKEND_HOST}/listings/search/`;
const DETAIL_URL = `https://${OWN_BACKEND_HOST}/listings/detail/`;
const SUBMIT_URL = `https://${OWN_BACKEND_HOST}/listings/submit/`;

// Deliberately SHORT (< MIN_STATE_VALUE_LENGTH, 8) so the generic
// length-descending cross-request STATE substitution pass
// (`interpolateStateValues`) never binds it on its own — isolating the
// exact-key + facet-splice mechanism this regression test targets, exactly
// as recon-generate.typed-facet-fields-not-interpolated-into-request-body-
// regression.test.ts's unit-level sibling does.
const REGION_VALUE = "north";
const FILTERS_VALUE = `region:${REGION_VALUE}|remote:true`;

function fixtureCaptures(): Capture[] {
  const list = buildCapture({
    url: LIST_URL,
    requestPostData: JSON.stringify({ page: 1, region: REGION_VALUE }),
    responseBody: { results: [{ itemId: "listing-a" }] },
    timestamp: "2026-01-01T00:00:00Z",
  });
  const detail = buildCapture({
    url: DETAIL_URL,
    requestPostData: JSON.stringify({ itemId: "listing-a", region: REGION_VALUE }),
    responseBody: { itemId: "listing-a", region: REGION_VALUE },
    timestamp: "2026-01-01T00:00:01Z",
  });
  // The submit body re-references `region` under its own genuine top-level
  // key, but ALSO packs the same value inside a differently-keyed, nested
  // facet-filter string one level below a "variables" envelope — never
  // itself a top-level key, so the exact-key pass never reaches it and only
  // the facet-splice mechanism can thread it.
  const submit = buildCapture({
    url: SUBMIT_URL,
    requestPostData: JSON.stringify({
      itemId: "listing-a",
      region: REGION_VALUE,
      variables: { itemId: "listing-a", filters: FILTERS_VALUE },
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

describe("recon-generate CLI — flow-declared scalar facet payload field interpolated into every request body", () => {
  it("emits a payload.Region accessor for every occurrence of the captured facet value across all action-step bodies, never a frozen literal", () => {
    workDir = mkdtempSync(
      join(tmpdir(), "barnacle-facet-field-not-body-interpolated-regression-e2e-")
    );
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `facet-field-not-body-interpolated-regression-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "browse listings search" },
          { step: "select the region facet", payloadField: "Region" },
          { step: "submit listing selection", submitStep: true },
        ],
        submitEndpointPattern: "listings/submit",
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

    // The declared facet field must actually be schema-required.
    expect(contract).toMatch(/\bregion\s*:\s*z\.string\(\)/);

    // Isolate every request-body template literal (the text between `body:`
    // and the following `schema:` field), across all three action-step
    // calls. A plain `` `([^`]*)` `` capture would stop at the FIRST nested
    // backtick a facet-splice's own inner template literal introduces (see
    // `spliceFacetsIntoStringVariable`'s `` `...${payload.x}...` `` output),
    // so this anchors on the next sibling field instead.
    const bodyTemplates = [...contract.matchAll(/body:\s*`([\s\S]*?)`,\s*\n\s*schema:/g)].map(
      (match) => match[1]!
    );
    expect(bodyTemplates.length, contract).toBeGreaterThanOrEqual(2);
    const allBodies = bodyTemplates.join("\n");

    // The captured facet value must never survive verbatim in any rendered
    // request body — every load-bearing occurrence must be interpolated.
    expect(allBodies).not.toContain(REGION_VALUE);

    // ${payload.region} must show up more than once: on the call whose body
    // carries it as its own exact top-level key on more than one step, AND
    // spliced inside the differently-keyed `filters` facet-filter string on
    // the submit call — not just the first, already-working occurrence.
    const payloadRegionOccurrences = allBodies.match(/\$\{payload\.region\}/g) ?? [];
    expect(payloadRegionOccurrences.length, allBodies).toBeGreaterThanOrEqual(3);

    // The differently-keyed, nested facet-filter string threads the splice,
    // keeping its own non-facet segment ("remote:true") literal — proving
    // the mechanism reaches beyond the exact-key pass, not just re-derives
    // the same accessor some other way.
    expect(allBodies).toMatch(/region:\$\{payload\.region\}/);
    expect(allBodies).toContain("remote:true");

    // No invalidly-nested placeholder anywhere in the emitted bodies.
    expect(allBodies).not.toMatch(/\$\{[^}]*\$\{/);

    // Any leftover raw literal (there should be none, per the above) may
    // only ever live in non-functional tracking headers, never in a body.
    const nonBodyContract = contract.replace(/body:\s*`[^`]*`/g, "body: ``");
    if (nonBodyContract.includes(REGION_VALUE)) {
      expect(contract).toMatch(
        new RegExp(`X-Page-Id.*${REGION_VALUE}|${REGION_VALUE}.*x-page-id`, "i")
      );
    }
  }, 30_000);
});
