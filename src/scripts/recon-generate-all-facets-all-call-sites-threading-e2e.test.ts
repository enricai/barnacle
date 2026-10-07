import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins that every declared facet (four array-carried string facets plus a
 * numeric scalar facet) is bound to `payload.<field>` at every call site that
 * carries its literal — as array element, nested array leaf or scalar —
 * while unrelated sibling literals stay and no wholesale
 * `JSON.stringify(payload.<array>)` or by-index accessor is emitted.
 * Generic library-catalog fixture.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.all-facets-all-sites-fixture.example.com";
const DELIMITER = ";src=facet";
const AUTHOR_TOKEN = "authorx-shelf-7001";
const GENRE_TOKEN = "genrex-shelf-7002";
const LANGUAGE_TOKEN = "langx-shelf-7003";
const FORMAT_TOKEN = "formatx-shelf-7004";
const BRANCH_ID = 880077;

const ARRAY_FACETS = ["AuthorFacet", "GenreFacet", "LanguageFacet", "FormatFacet"];
const SITE_PATHS = [
  "/library/lookup-a/",
  "/library/lookup-b/",
  "/library/lookup-c/",
  "/library/lookup-d/",
];

function tagged(token: string): string {
  return `${token}${DELIMITER}`;
}

function fixtureCaptures(): Capture[] {
  const bodies: unknown[] = [
    {
      filters: [
        { name: "kind", values: ["book"] },
        {
          name: "author",
          values: [tagged(AUTHOR_TOKEN)],
          nested: [tagged(FORMAT_TOKEN), "keep-a"],
        },
      ],
      branchId: BRANCH_ID,
      page: 1,
    },
    {
      filters: ["keep-b", tagged(GENRE_TOKEN), tagged(AUTHOR_TOKEN), tagged(LANGUAGE_TOKEN)],
      branchId: BRANCH_ID,
      page: 2,
    },
    {
      filters: [tagged(LANGUAGE_TOKEN), "keep-c"],
      groups: [{ label: "g", formats: [tagged(FORMAT_TOKEN), "keep-d"] }],
      page: 3,
    },
    { filters: ["keep-e", "keep-f"], page: 4 },
  ];
  return bodies.map((body, index) =>
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}${SITE_PATHS[index]}`,
      requestPostData: JSON.stringify(body),
      responseBody: { ok: true },
      timestamp: `2026-06-01T00:00:0${index}.000Z`,
    })
  );
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

describe("recon-generate CLI — every facet at every call site", () => {
  it("binds each declared facet wherever its literal appears and keeps sibling literals", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-all-facets-all-sites-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());
    const siteId = `all-facets-all-sites-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    const base = `https://${OWN_BACKEND_HOST}/#/library`;
    const tokens = [AUTHOR_TOKEN, GENRE_TOKEN, LANGUAGE_TOKEN, FORMAT_TOKEN];
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          ...ARRAY_FACETS.map((field, index) => ({
            step: `navigate to the shelf with the ${field} applied`,
            navigateTo: `${base}/${tokens.slice(0, index + 1).join("/")}`,
            payloadField: field,
          })),
          {
            step: "navigate to the branch shelf",
            navigateTo: `${base}/${tokens.join("/")}/branch/${BRANCH_ID}`,
            payloadField: "BranchFacet",
          },
          { step: "look up books", submitStep: true },
        ],
        submitEndpointPattern: "library/lookup-d",
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

    for (const token of tokens) expect(contract).not.toContain(token);
    expect(contract).not.toContain(String(BRANCH_ID));
    expect(contract).not.toMatch(/payload\.(filters|groups)\[/);

    for (const sibling of ["keep-a", "keep-b", "keep-c", "keep-d"]) {
      expect(contract).toContain(sibling);
    }

    const chunks = contract.split("httpClient(`").slice(1);
    const siteChunk = (path: string): string => {
      const chunk = chunks.find((candidate) => candidate.startsWith(`\${payload.BaseUrl}${path}`));
      expect(chunk, contract).toBeDefined();
      return chunk ?? "";
    };
    const expectedFacets: Record<string, string[]> = {
      "/library/lookup-a/": ["AuthorFacet", "FormatFacet", "BranchFacet"],
      "/library/lookup-b/": ["GenreFacet", "AuthorFacet", "LanguageFacet", "BranchFacet"],
      "/library/lookup-c/": ["LanguageFacet", "FormatFacet"],
      "/library/lookup-d/": [],
    };
    for (const [path, facets] of Object.entries(expectedFacets)) {
      const chunk = siteChunk(path);
      // No site passes a facet-owned array through wholesale, whether or not
      // its own array carries a facet.
      expect(chunk).not.toContain("JSON.stringify(payload.filters)");
      for (const facet of facets) expect(chunk).toContain(`payload.${facet}`);
      for (const facet of [...ARRAY_FACETS, "BranchFacet"].filter((f) => !facets.includes(f))) {
        expect(chunk).not.toContain(`payload.${facet}`);
      }
    }
  }, 60_000);
});
