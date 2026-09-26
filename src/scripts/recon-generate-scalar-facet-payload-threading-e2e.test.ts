import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Full-pipeline counterpart to recon-generate-primary-capture-facet-wiring-e2e's
 * facet-string case: here every facet is its own TYPED SCALAR body field (not
 * a packed `key:value|key:value` string), each declared by a distinct flow
 * fill step and recurring, with the same captured literal, across several
 * separate REST request bodies — mirroring the report's `region` /
 * `departureCity` / `travelMonth` / `theme` fields, none of which packed into
 * a `filters`-style composite string. The generator's persona-binding pass
 * (harvestPersonaBindings -> payload.<Field> substitution) is the same
 * mechanism already proven correct for the array-valued `filters` field
 * itself; this test proves it also reaches every plain scalar leaf, at EVERY
 * occurrence across EVERY captured body, through the real CLI over the
 * emitted contract.ts — not just in one hand-picked call site.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.scalar-facet-threading-fixture.example.com";
const SEARCH_URL = `https://${OWN_BACKEND_HOST}/api/trip-search`;
const PLAN_URL = `https://${OWN_BACKEND_HOST}/api/trip-plan`;
const CONFIRM_URL = `https://${OWN_BACKEND_HOST}/api/trip-confirm`;

// Kept under 8 characters (recon-generate.ts's MIN_STATE_VALUE_LENGTH): the
// generic same-value cross-request STATE threading pass this test is NOT
// exercising only registers values at or above that floor, so a longer
// literal would additionally engage that unrelated mechanism and muddy which
// pass actually produced the splice this test is asserting on.
const REGION = "Pacific";
const DEPARTURE_CITY = "Seattle";
const TRAVEL_MONTH = "June";
const THEME = "Alpine";

function reportShapeCaptures(): Capture[] {
  const search = buildCapture({
    url: SEARCH_URL,
    requestPostData: JSON.stringify({ region: REGION, departureCity: DEPARTURE_CITY }),
    responseBody: { results: [{ id: "trip-1" }] },
    timestamp: "2024-01-01T00:00:00Z",
  });
  const plan = buildCapture({
    url: PLAN_URL,
    requestPostData: JSON.stringify({ travelMonth: TRAVEL_MONTH, theme: THEME }),
    responseBody: { plan: { id: "plan-1" } },
    timestamp: "2024-01-01T00:01:00Z",
  });
  const confirm = buildCapture({
    url: CONFIRM_URL,
    requestPostData: JSON.stringify({
      region: REGION,
      departureCity: DEPARTURE_CITY,
      travelMonth: TRAVEL_MONTH,
      theme: THEME,
    }),
    responseBody: { confirmation: { id: "conf-1" } },
    timestamp: "2024-01-01T00:02:00Z",
  });
  return [search, plan, confirm];
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

function writeVocabularyModule(dir: string): string {
  const vocabPath = join(dir, "vocabulary.mjs");
  writeFileSync(
    vocabPath,
    `export const vocabulary = {
  subject: /(?!)/,
  exclusions: [],
  table: [
    [/region/i, "Region"],
    [/departure ?city/i, "DepartureCity"],
    [/travel ?month/i, "TravelMonth"],
    [/theme/i, "Theme"],
  ],
};
`
  );
  return vocabPath;
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate CLI — typed scalar facet fields thread into every request body occurrence", () => {
  it("splices every recurrence of each declared scalar field with payload.<Field>, leaving no hardcoded facet literal behind", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-scalar-facet-threading-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, reportShapeCaptures());

    const siteId = `scalar-facet-threading-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });

    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: `Fill in the Region field with '${REGION}'` },
          { step: `Fill in the Departure City field with '${DEPARTURE_CITY}'` },
          { step: `Fill in the Travel Month field with '${TRAVEL_MONTH}'` },
          { step: `Fill in the Theme field with '${THEME}'`, submitStep: true },
        ],
        submitEndpointPattern: "trip-confirm",
        requireSubmitEndpointMatch: true,
        ownBackendHostnames: [OWN_BACKEND_HOST],
      })
    );

    const vocabularyPath = writeVocabularyModule(workDir);

    const result = spawnSync(
      TSX_BIN,
      [
        GENERATE_SCRIPT,
        "--site-id",
        siteId,
        "--run-dir",
        runRoot,
        "--emit",
        "ts",
        "--force",
        "--vocabulary",
        vocabularyPath,
      ],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    const bodyLiterals = [...contract.matchAll(/body:\s*`([\s\S]*?)`/g)].map((m) => m[1] ?? "");
    expect(bodyLiterals.length).toBeGreaterThan(0);

    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    expect(contract).toContain("${payload.Region}");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    expect(contract).toContain("${payload.DepartureCity}");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    expect(contract).toContain("${payload.TravelMonth}");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    expect(contract).toContain("${payload.Theme}");

    // No body literal keeps a hardcoded facet value on any occurrence — the
    // fix must reach EVERY recurrence, not just the first body it appears in.
    for (const body of bodyLiterals) {
      expect(body).not.toContain(REGION);
      expect(body).not.toContain(DEPARTURE_CITY);
      expect(body).not.toContain(TRAVEL_MONTH);
      expect(body).not.toContain(THEME);
    }
  }, 30_000);
});
