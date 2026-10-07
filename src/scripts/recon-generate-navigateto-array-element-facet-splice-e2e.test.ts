import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Closes the report's exact single-facet shape: a navigateTo-declared
 * payloadField whose extracted literal never appears standalone anywhere,
 * but recurs — suffixed by a constant delimiter string — as one element
 * inside a different array-typed field that the generator would otherwise
 * freeze wholesale via `${JSON.stringify(payload.<arrayField>)}` before the
 * substring-splice pass ever got a chance to thread it. Drives the real
 * `recon:generate` CLI over a generic catalog/e-commerce domain fixture.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.navigateto-array-element-facet-splice-fixture.example.com";
const CATEGORY_HASH_TOKEN = "catx-array-facet-hash-7731";
const SOURCE_ID = "urlFriendlyId";

function fixtureCaptures(): Capture[] {
  return [
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/catalog/browse/`,
      requestPostData: JSON.stringify({ sort: "relevance" }),
      responseBody: { ok: true },
      timestamp: "2026-04-01T00:00:00.000Z",
    }),
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/catalog/filter-results/`,
      requestPostData: JSON.stringify({
        sort: "relevance",
        tags: ["in-stock", `${CATEGORY_HASH_TOKEN};sourceId=${SOURCE_ID}`, "free-shipping"],
      }),
      responseBody: { ok: true },
      timestamp: "2026-04-01T00:00:01.000Z",
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

/**
 * Body template of every `httpClient(...)` call. Split on the emitter's stable
 * idiom rather than a backtick-free regex, because a spliced array renders as
 * `${JSON.stringify([`${payload.X}...`])}` and nests backticks.
 */
function extractBodyBlocks(contract: string): string[] {
  return contract
    .split("httpClient(`")
    .slice(1)
    .map((chunk) => chunk.slice(chunk.indexOf("body: `") + "body: `".length))
    .map((chunk) => chunk.slice(0, chunk.indexOf("`,\n      schema:")));
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate CLI — navigateTo facet literal recurring inside a wholesale-swallowed array field", () => {
  it("splices payload.<Field> inside the array-carrying body template instead of freezing the whole array", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-navigateto-array-element-facet-splice-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `navigateto-array-element-facet-splice-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          {
            step: "navigate to the catalog with the category facet applied",
            navigateTo: `https://${OWN_BACKEND_HOST}/#/catalog/${CATEGORY_HASH_TOKEN}`,
            payloadField: "CategoryFacet",
          },
          { step: "browse catalog" },
          { step: "apply filters", submitStep: true },
        ],
        submitEndpointPattern: "catalog/filter-results",
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
    const expectedSplice = "${payload.CategoryFacet}";

    const bodyBlocks = extractBodyBlocks(contract);
    expect(bodyBlocks.length, contract).toBeGreaterThan(0);

    // The splice must appear inside the array-carrying body text — the
    // `tags` field is never swallowed wholesale into an opaque
    // `${JSON.stringify(payload.tags)}` blob before the splice threads it.
    expect(bodyBlocks.some((b) => b.includes(expectedSplice))).toBe(true);

    // The raw navigateTo hash literal must never survive frozen anywhere in
    // the body — every occurrence was rewritten to the payload accessor.
    for (const body of bodyBlocks) {
      expect(body).not.toContain(CATEGORY_HASH_TOKEN);
    }

    // The payload schema still declares the facet field as a required string.
    const schemaMatch = contract.match(
      /PayloadSchema = z\.object\(\{[\s\S]*?\n\}\)(?:\.extend\(\{[\s\S]*?\n\}\))?;/
    );
    expect(schemaMatch, contract).not.toBeNull();
    const schema = schemaMatch?.[0] ?? "";
    expect(schema).toMatch(/ {2}CategoryFacet: z\.string\(\),/);
  }, 30_000);
});
