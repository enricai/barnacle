import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
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

const MIX_HOST = "www.structured-array-all-facets-fixture.example.com";
const MIX_TOKEN_A = "tokena-depot-8001";
const MIX_TOKEN_B = "tokenb-depot-8002";
const MIX_PATHS = ["/depot/query-a/", "/depot/query-b/", "/depot/query-c/"];

function mixCaptures(): Capture[] {
  const a = tagged(MIX_TOKEN_A);
  const b = tagged(MIX_TOKEN_B);
  const ordering = [
    { criteria: "price", order: "ASC" },
    { criteria: a, order: "ASC" },
  ];
  const bodies: unknown[] = [
    { ordering, tags: [a, "keep-x", b], noise: "ordering" },
    { ordering, tags: ["keep-y", b, a], page: 1 },
    { tags: [a, b], page: 2 },
  ];
  return bodies.map((body, index) =>
    buildCapture({
      url: `https://${MIX_HOST}${MIX_PATHS[index]}`,
      requestPostData: JSON.stringify(body),
      responseBody: { ok: true },
      timestamp: `2026-06-01T00:00:0${index}.000Z`,
    })
  );
}

/** Returns the PayloadSchema text declaring `field`, up to the next top-level key. */
function schemaFieldText(contract: string, field: string): string {
  const schema = contract.match(
    /PayloadSchema = z\.object\(\{[\s\S]*?\n\}\)(?:\.extend\(\{[\s\S]*?\n\}\))?;/
  );
  const text = schema?.[0] ?? "";
  return text.match(new RegExp(` {2}${field}:[\\s\\S]*?(?=\\n {2}\\S|\\n\\}\\))`))?.[0] ?? "";
}

let workDir: string | null = null;
let siteOutDir: string | null = null;
let tsconfigPath: string | null = null;

afterEach(() => {
  if (tsconfigPath) rmSync(tsconfigPath, { force: true });
  tsconfigPath = null;
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

  it("gives a structured array field one shape, threads every facet at every site, and typechecks", () => {
    if (!existsSync(TSC_BIN))
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    workDir = mkdtempSync(join(tmpdir(), "barnacle-structured-all-facets-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, mixCaptures());
    const siteId = `structured-all-facets-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    const base = `https://${MIX_HOST}/#/depot`;
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          {
            step: "navigate with the first facet applied",
            navigateTo: `${base}/${MIX_TOKEN_A}`,
            payloadField: "FirstFacet",
          },
          {
            step: "navigate with the second facet applied",
            navigateTo: `${base}/${MIX_TOKEN_A}/${MIX_TOKEN_B}`,
            payloadField: "SecondFacet",
            optional: true,
          },
          { step: "query depot", submitStep: true },
        ],
        submitEndpointPattern: "depot/query-c",
        requireSubmitEndpointMatch: true,
        ownBackendHostnames: [MIX_HOST],
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    const ordering = schemaFieldText(contract, "ordering");
    expect(ordering, contract).toMatch(/z\.array\(\s*z\.object/);
    expect(ordering).not.toMatch(/z\.string\(\)/);
    expect(contract).not.toMatch(/payload\.ordering(?!\[)/);
    for (const token of [MIX_TOKEN_A, MIX_TOKEN_B]) expect(contract).not.toContain(token);
    expect(contract).not.toMatch(/JSON\.stringify\(payload\.tags\)/);
    expect(contract).not.toMatch(/payload\.tags\[/);
    for (const keep of ["keep-x", "keep-y"]) expect(contract).toContain(keep);

    const chunks = contract.split("httpClient(`").slice(1);
    for (const path of MIX_PATHS) {
      const chunk = chunks.find((c) => c.startsWith(`\${payload.BaseUrl}${path}`)) ?? "";
      expect(chunk, `${path}: ${contract}`).toContain("payload.FirstFacet");
      expect(chunk, path).toContain("payload.SecondFacet");
    }

    tsconfigPath = join(REPO_ROOT, `tsconfig.structured-all-facets.${process.pid}.json`);
    writeFileSync(
      tsconfigPath,
      JSON.stringify({
        extends: "./tsconfig.json",
        compilerOptions: {
          noEmit: true,
          incremental: false,
          tsBuildInfoFile: null,
          paths: {
            "@/*": ["./src/*"],
            "@test/*": ["./test/*"],
            "@enricai/barnacle/*": ["./src/*"],
          },
        },
        include: [`src/sites/${siteId}/**/*.ts`],
      })
    );
    const check = spawnSync(TSC_BIN, ["-p", tsconfigPath, "--noEmit"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(check.status, `${check.stdout}\n${check.stderr}\n${contract}`).toBe(0);
  }, 120_000);
});
