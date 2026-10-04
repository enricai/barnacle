import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * End-to-end proof, through the real `recon:generate` CLI, for the reported
 * regression: a `navigateTo`-declared scalar facet (`payloadField`) whose
 * hash-derived value recurs, with a constant suffix still attached, as an
 * ELEMENT of a later captured request body's array field must get spliced
 * into that array element's position — not left unthreaded while the array
 * is frozen wholesale as an opaque `${JSON.stringify(payload.tags)}` blob
 * with the facet literal still embedded verbatim inside it. Distinct from
 * recon-generate-array-facet-payload-threading-e2e.test.ts (a typed
 * array-of-OBJECTS field that must always splice as JSON.stringify) and from
 * the unit-level regression in bugfix-002 — this proves the real
 * navigateTo+payloadField->personaBindings->payloadAccessorByValue
 * registration path survives the full per-capture body pipeline.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.navigateto-facet-array-element-threading-fixture.example.com";

// The navigateTo step's declared facet: a job-board "department" facet whose
// value is derived from the URL's trailing hash segment, mirroring
// harvestPersonaBindings' navigateTo+payloadField+hash-fragment grammar
// (recon-generate.ts's extractNavigateToHashFragmentValue).
const FACET_VALUE = "widgetscorp";

// The captured "apply filters" body batches the facet alongside an unrelated
// filter as a top-level JSON array field, each element suffixed with a
// constant marker — mirroring the finding's own report of the facet value
// recurring "merely suffixed with [a] constant string" inside an adjacent
// array, rather than appearing as a standalone, exactly-matching top-level
// value.
const TAGS_ARRAY = [`${FACET_VALUE};facetId=categoryCode`, "evergreen;facetId=categoryCode"];

function fixtureCaptures(): Capture[] {
  return [
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/jobs/browse/`,
      requestPostData: JSON.stringify({ sort: "recent" }),
      responseBody: { ok: true },
      timestamp: "2026-01-01T00:00:00.000Z",
    }),
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/jobs/filter/`,
      requestPostData: JSON.stringify({ tags: TAGS_ARRAY }),
      responseBody: { ok: true },
      timestamp: "2026-01-01T00:00:01.000Z",
    }),
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/jobs/submit/`,
      requestPostData: JSON.stringify({ confirm: true }),
      responseBody: { ok: true },
      timestamp: "2026-01-01T00:00:02.000Z",
    }),
  ];
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

describe("recon-generate CLI — navigateTo-declared facet threaded into a later array element, not swallowed", () => {
  it("splices the payload.department accessor into the tags array element instead of freezing the array with the literal still embedded", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-navigateto-facet-array-element-threading-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `navigateto-facet-array-element-threading-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          {
            step: "navigate to the jobs page pre-filtered by department",
            navigateTo: `https://${OWN_BACKEND_HOST}/#/jobs/${FACET_VALUE}`,
            payloadField: "department",
          },
          { step: "browse job listings" },
          { step: "apply job filters" },
          { step: "submit application", submitStep: true },
        ],
        submitEndpointPattern: "jobs/submit",
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

    const contractPath = join(siteOutDir, "contract.ts");
    const contract = readFileSync(contractPath, "utf8");

    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    const expectedSplice = "${payload.department}";
    expect(contract, contract).toContain(expectedSplice);

    // The splice must land specifically inside the tags array element's own
    // position, not merely somewhere in the file (e.g. a tracking header) —
    // the array must never survive as a frozen opaque blob with the facet
    // literal still embedded verbatim inside it.
    const bodyBlocks = [...contract.matchAll(/body:\s*`([^`]*)`,/g)].map((m) => m[1] ?? "");
    expect(bodyBlocks.length, contract).toBeGreaterThan(0);
    const tagsBodies = bodyBlocks.filter((b) => b.includes('"tags"'));
    expect(tagsBodies.length, contract).toBeGreaterThan(0);
    for (const body of tagsBodies) {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source
      expect(body).not.toContain("${JSON.stringify(payload.tags)}");
      expect(body).not.toContain(FACET_VALUE);
      expect(body).toContain(`${expectedSplice};facetId=categoryCode`);
    }

    // The payload schema still declares the facet field required (no
    // regression of the 1.12.76 optionality fix).
    const schemaMatch = contract.match(
      /PayloadSchema = z\.object\(\{[\s\S]*?\n\}\)(?:\.extend\(\{[\s\S]*?\n\}\))?;/
    );
    expect(schemaMatch, contract).not.toBeNull();
    const schema = schemaMatch?.[0] ?? "";
    const departmentFieldMatch = schema.match(/ {2}department:[\s\S]*?\n {2}\S/);
    expect(departmentFieldMatch, schema).not.toBeNull();
    expect(departmentFieldMatch![0]).not.toMatch(/\.optional\(\)/);
  }, 30_000);
});
