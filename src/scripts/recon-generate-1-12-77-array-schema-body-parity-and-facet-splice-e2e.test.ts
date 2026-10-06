import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Repro pin for two defects on a multi-call capture: (1) a field the bodies
 * index as `payload.ordering["0"]!.criteria` must be declared on PayloadSchema
 * as `z.array(z.object({...criteria...}))`, never a bare `z.string()`; (2) a
 * declared navigateTo payloadField facet recurring inside the `tags` array
 * must be spliced as `payload.<field>` at EVERY call site of that array, with
 * no `JSON.stringify(payload.tags)` passthrough and no `payload.tags["N"]!`
 * by-index accessor left behind. Generic retail catalogue fixture.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.array-schema-body-parity-facet-splice-fixture.example.com";
const DELIMITER = ";kind=slug";
const CATEGORY_TOKEN = "categoryx-retail-7001";
const BRAND_TOKEN = "brandx-retail-7002";
const SITE_PATHS = ["/shop/query-a/", "/shop/query-b/", "/shop/query-c/", "/shop/query-d/"];

function tagged(token: string): string {
  return `${token}${DELIMITER}`;
}

function fixtureCaptures(): Capture[] {
  const category = tagged(CATEGORY_TOKEN);
  const brand = tagged(BRAND_TOKEN);
  const ordering = [
    { criteria: "price", order: "ASC", region: "MI" },
    { criteria: category, order: "ASC", region: "MI" },
  ];
  const bodies: unknown[] = [
    {
      ordering,
      tags: [`a${DELIMITER}`, category, `b${DELIMITER}`],
    },
    {
      ordering,
      tags: [`a${DELIMITER}`, category, brand, `b${DELIMITER}`],
    },
    { tags: [brand, `winter-2026${DELIMITER}`, category] },
    { tags: [category, brand], page: 1 },
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

/** Splits on the emitter's stable idiom because bodies can nest backtick templates. */
function extractCallSiteBodies(contract: string): Map<string, string> {
  const bodies = new Map<string, string>();
  // biome-ignore lint/suspicious/noTemplateCurlyInString: matching emitted source text, not a template.
  const chunks = contract.split("httpClient(`${payload.BaseUrl}").slice(1);
  for (const chunk of chunks) {
    const url = chunk.slice(0, chunk.indexOf("`,"));
    const bodyStart = chunk.indexOf("body: `") + "body: `".length;
    const bodyEnd = chunk.indexOf("`,\n      schema:");
    bodies.set(url, chunk.slice(bodyStart, bodyEnd));
  }
  return bodies;
}

/** Returns the PayloadSchema line(s) declaring `field`, up to the next top-level key. */
function schemaFieldText(contract: string, field: string): string {
  const schema = contract.match(
    /PayloadSchema = z\.object\(\{[\s\S]*?\n\}\)(?:\.extend\(\{[\s\S]*?\n\}\))?;/
  );
  const text = schema?.[0] ?? "";
  return text.match(new RegExp(` {2}${field}:[\\s\\S]*?(?=\\n {2}\\S|\\n\\}\\))`))?.[0] ?? "";
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate CLI — array schema/body parity and facet splice at every call site", () => {
  it("keeps every payload accessor consistent with the declared schema and splices each facet at every array site", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-array-schema-body-parity-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `array-schema-body-parity-facet-splice-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    const base = `https://${OWN_BACKEND_HOST}/#/shop`;
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          {
            step: "navigate to the shop with the category facet applied",
            navigateTo: `${base}/category/${CATEGORY_TOKEN}`,
            payloadField: "CategoryFacet",
          },
          {
            step: "navigate to the shop with the brand facet applied",
            navigateTo: `${base}/category/${CATEGORY_TOKEN}/brand/${BRAND_TOKEN}`,
            payloadField: "BrandFacet",
            optional: true,
          },
          { step: "browse shop" },
          { step: "query shop", submitStep: true },
        ],
        submitEndpointPattern: "shop/query-d",
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
    expect(bodies.size, contract).toBe(SITE_PATHS.length);

    // (a) schema/body parity: an indexed accessor demands an array-of-object schema.
    const indexed = [...contract.matchAll(/payload\.(\w+)\["\d+"\]!\.\w+/g)].map((m) => m[1] ?? "");
    for (const field of new Set(indexed)) {
      const decl = schemaFieldText(contract, field);
      expect(decl, `${field} indexed in body but not declared:\n${contract}`).not.toBe("");
      expect(decl, `${field} declared as scalar:\n${decl}`).not.toMatch(/z\.string\(\)/);
      expect(decl).toMatch(/z\.array\(\s*z\.object/);
    }

    // (b) facet splice at every call site; no passthrough or by-index leftovers.
    for (const token of [CATEGORY_TOKEN, BRAND_TOKEN]) expect(contract).not.toContain(token);
    expect(contract).not.toMatch(/JSON\.stringify\(payload\.tags\)/);
    expect(contract).not.toMatch(/payload\.tags\[/);
    for (const path of SITE_PATHS) {
      const body = bodies.get(path) ?? "";
      expect(body, `${path}: ${contract}`).toContain("payload.CategoryFacet");
      if (path !== SITE_PATHS[0]) expect(body, path).toContain("payload.BrandFacet");
    }
    // The facet token inside the ordering array must be the facet accessor,
    // not a frozen by-index accessor on the array.
    for (const path of SITE_PATHS.slice(0, 2)) {
      expect(bodies.get(path) ?? "", path).not.toMatch(/payload\.ordering\["\d+"\]!/);
    }
  }, 60_000);
});
