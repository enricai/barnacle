import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins that every facet is spliced at every one of three call sites whose
 * `filters` arrays differ in length and literals, even when the first
 * captured body carries no facet values: `payload.<field>` (conditional
 * spread when optional), no raw facet literal, no by-index accessor.
 * Generic library-catalog fixture.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.array-facet-three-site-differing-fixture.example.com";
const DELIMITER = ";src=facet";
const AUTHOR_TOKEN = "authorx-shelf-7001";
const GENRE_TOKEN = "genrex-shelf-7002";
const LANGUAGE_TOKEN = "langx-shelf-7003";
const SUFFIX = "available=true";

function tagged(token: string): string {
  return `${token}${DELIMITER}`;
}

function fixtureCaptures(): Capture[] {
  return [
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/library/browse/`,
      requestPostData: JSON.stringify({ filters: ["kind=book", SUFFIX] }),
      responseBody: { ok: true },
      timestamp: "2026-06-01T00:00:00.000Z",
    }),
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/library/lookup-books/`,
      requestPostData: JSON.stringify({
        filters: [
          "kind=book",
          tagged(AUTHOR_TOKEN),
          tagged(GENRE_TOKEN),
          tagged(LANGUAGE_TOKEN),
          SUFFIX,
        ],
      }),
      responseBody: { ok: true },
      timestamp: "2026-06-01T00:00:01.000Z",
    }),
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/library/lookup-refine/`,
      requestPostData: JSON.stringify({
        filters: [tagged(AUTHOR_TOKEN), tagged(GENRE_TOKEN), tagged(LANGUAGE_TOKEN)],
        refine: true,
      }),
      responseBody: { ok: true },
      timestamp: "2026-06-01T00:00:01.500Z",
    }),
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/library/lookup-summary/`,
      requestPostData: JSON.stringify({
        filters: [
          "lang=any",
          tagged(AUTHOR_TOKEN),
          tagged(GENRE_TOKEN),
          tagged(LANGUAGE_TOKEN),
          SUFFIX,
          "page=1",
        ],
        summaryOnly: true,
      }),
      responseBody: { ok: true },
      timestamp: "2026-06-01T00:00:02.000Z",
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
 * Extracts the `body: \`...\`` template-literal content of each
 * `await httpClient(\`${payload.BaseUrl}<path>\`, { ... })` call in the
 * emitted contract, keyed by the call's URL path. Each body may itself
 * contain nested backtick template expressions (e.g.
 * `` `${payload.RegionFacet};src=facet` ``), so a naive `` /`([^`]*)`/ ``
 * regex would stop at the first nested backtick — splitting on the fixed
 * `httpClient(\`${payload.BaseUrl}` prefix and the fixed `` `,\n      schema: ``
 * suffix (the emitter's own stable idiom) avoids that.
 */
function extractCallSiteBodies(contract: string): Map<string, string> {
  const bodies = new Map<string, string>();
  // biome-ignore lint/suspicious/noTemplateCurlyInString: matching against emitted source text, not a template.
  const chunks = contract.split("httpClient(`${payload.BaseUrl}").slice(1);
  for (const chunk of chunks) {
    const urlEnd = chunk.indexOf("`,");
    const url = chunk.slice(0, urlEnd);
    const bodyStart = chunk.indexOf("body: `") + "body: `".length;
    const bodyEnd = chunk.indexOf("`,\n      schema:");
    bodies.set(url, chunk.slice(bodyStart, bodyEnd));
  }
  return bodies;
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate CLI — three call sites with differing filters arrays", () => {
  it("splices every facet at every site even when the first body has no facet values", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-array-facet-three-site-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `array-facet-three-site-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    const base = `https://${OWN_BACKEND_HOST}/#/library`;
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          {
            step: "navigate to the shelf with the author facet applied",
            navigateTo: `${base}/author/${AUTHOR_TOKEN}`,
            payloadField: "AuthorFacet",
          },
          {
            step: "navigate to the shelf with the genre facet applied",
            navigateTo: `${base}/author/${AUTHOR_TOKEN}/genre/${GENRE_TOKEN}`,
            payloadField: "GenreFacet",
          },
          {
            step: "navigate to the shelf with the language facet applied",
            navigateTo: `${base}/author/${AUTHOR_TOKEN}/genre/${GENRE_TOKEN}/lang/${LANGUAGE_TOKEN}`,
            payloadField: "LanguageFacet",
            optional: true,
          },
          { step: "browse library" },
          { step: "look up books", submitStep: true },
        ],
        submitEndpointPattern: "library/lookup-summary",
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
    const bodies = extractCallSiteBodies(contract);

    for (const token of [AUTHOR_TOKEN, GENRE_TOKEN, LANGUAGE_TOKEN]) {
      expect(contract).not.toContain(token);
    }
    expect(contract).not.toMatch(/payload\.filters\[/);

    for (const path of [
      "/library/lookup-books/",
      "/library/lookup-refine/",
      "/library/lookup-summary/",
    ]) {
      const body = bodies.get(path);
      expect(body, contract).toBeDefined();
      expect(body).toContain(`\${payload.AuthorFacet}`);
      expect(body).toContain(`\${payload.GenreFacet}`);
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
      expect(body).toContain("...(payload.LanguageFacet ? [`${payload.LanguageFacet}");
    }
    expect(bodies.get("/library/lookup-books/")).toContain("kind=book");
    expect(bodies.get("/library/lookup-summary/")).toContain("page=1");
  }, 30_000);
});
