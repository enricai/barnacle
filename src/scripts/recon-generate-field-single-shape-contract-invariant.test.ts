import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Pins that each payload field gets exactly one shape decision: the schema
 * declaration agrees with every accessor/splice at every call site, and the
 * decision does not depend on capture or facet registration order.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");
const HOST = "www.field-single-shape-fixture.example.com";
const DELIMITER = ";kind=slug";

interface ShapeCase {
  name: string;
  bodies: unknown[];
  facets: Array<{ payloadField: string; token: string }>;
}

type UsageClass = "scalar" | "indexed" | "wholesale";

const CASES: ShapeCase[] = [
  {
    name: "scalar facet spliced into a string body field",
    facets: [{ payloadField: "CityFacet", token: "cityx-shop-8001" }],
    bodies: [
      { city: `cityx-shop-8001${DELIMITER}`, page: 1 },
      { city: `cityx-shop-8001${DELIMITER}`, page: 2 },
    ],
  },
  {
    name: "array facet inside a string-array filters field",
    facets: [
      { payloadField: "CityFacet", token: "cityx-shop-8001" },
      { payloadField: "BrandFacet", token: "brandx-shop-8002" },
    ],
    bodies: [
      { filters: ["type=any", `cityx-shop-8001${DELIMITER}`, `brandx-shop-8002${DELIMITER}`] },
      { filters: [`cityx-shop-8001${DELIMITER}`, `brandx-shop-8002${DELIMITER}`], refine: true },
    ],
  },
  {
    name: "object-array field carrying a facet element",
    facets: [{ payloadField: "CuisineFacet", token: "cuisine-hash-1001" }],
    bodies: [
      {
        orderCriteria: [
          { field: "relevance", direction: "desc" },
          { field: `cuisine-hash-1001${DELIMITER}`, direction: "asc" },
        ],
      },
      {
        orderCriteria: [
          { field: "relevance", direction: "desc" },
          { field: `cuisine-hash-1001${DELIMITER}`, direction: "asc" },
        ],
      },
    ],
  },
  {
    name: "facet field colliding with an array key and a scalar key",
    facets: [{ payloadField: "filters", token: "cityx-shop-8001" }],
    bodies: [
      { filters: ["a", `cityx-shop-8001${DELIMITER}`], q: `cityx-shop-8001${DELIMITER}` },
      { filters: [`cityx-shop-8001${DELIMITER}`], q: "x" },
    ],
  },
  {
    name: "one field named by several scalar sources",
    facets: [{ payloadField: "CityFacet", token: "cityx-shop-8001" }],
    bodies: [
      { city: `cityx-shop-8001${DELIMITER}`, location: `cityx-shop-8001${DELIMITER}` },
      { place: `cityx-shop-8001${DELIMITER}`, city: `cityx-shop-8001${DELIMITER}` },
    ],
  },
];

function schemaBlock(contract: string): string {
  const match = contract.match(
    /PayloadSchema = z\.object\(\{[\s\S]*?\n\}\)(?:\.extend\(\{[\s\S]*?\n\}\))?;/
  );
  expect(match, contract).not.toBeNull();
  return match?.[0] ?? "";
}

function usageClasses(contract: string): Map<string, Set<UsageClass>> {
  const usages = new Map<string, Set<UsageClass>>();
  const record = (pattern: RegExp, kind: UsageClass): void => {
    for (const m of contract.matchAll(pattern)) {
      const field = m[1] ?? "";
      usages.set(field, (usages.get(field) ?? new Set()).add(kind));
    }
  };
  record(/\$\{payload\.(\w+)\}/g, "scalar");
  record(/payload\.(\w+)(?:!|\?)?\[/g, "indexed");
  record(/JSON\.stringify\(payload\.(\w+)\)/g, "wholesale");
  return usages;
}

function declaredShape(schema: string, field: string): string {
  const line = schema.split("\n").find((l) => new RegExp(`^\\s*${field}:`).test(l));
  return (line ?? "").replace(/\s+/g, " ").trim();
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

function generate(bodies: unknown[], facets: ShapeCase["facets"], tag: string): string {
  workDir = mkdtempSync(join(tmpdir(), "barnacle-field-single-shape-"));
  const runRoot = join(workDir, "run");
  mkdirSync(join(runRoot, "graphql"), { recursive: true });
  mkdirSync(join(runRoot, "replays"), { recursive: true });
  mkdirSync(join(runRoot, "aux"), { recursive: true });
  writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
  bodies.forEach((body, index) => {
    const capture = buildCapture({
      url: `https://${HOST}/shop/site-${index}/`,
      requestPostData: JSON.stringify(body),
      responseBody: { ok: true },
      timestamp: `2026-05-01T00:00:0${index}.000Z`,
    });
    writeFileSync(
      join(runRoot, "graphql", `${String(index).padStart(3, "0")}-capture.json`),
      JSON.stringify(capture)
    );
  });

  const siteId = `field-single-shape-test-${tag}-${process.pid}`;
  siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({
      steps: [
        ...facets.map(({ payloadField, token }) => ({
          step: `navigate with ${payloadField}`,
          navigateTo: `https://${HOST}/#/shop/${token}`,
          payloadField,
        })),
        { step: "browse" },
        { step: "submit", submitStep: true },
      ],
      submitEndpointPattern: "shop/site-",
      requireSubmitEndpointMatch: true,
      ownBackendHostnames: [HOST],
    })
  );

  const result = spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
  rmSync(siteOutDir, { recursive: true, force: true });
  siteOutDir = null;
  return contract;
}

function shapeSignature(contract: string): Record<string, string> {
  const schema = schemaBlock(contract);
  return Object.fromEntries(
    [...usageClasses(contract).keys()].sort().map((f) => [f, declaredShape(schema, f)])
  );
}

describe("recon-generate CLI — one shape decision per payload field", () => {
  it.each(CASES)(
    "$name",
    ({ bodies, facets }) => {
      const forward = generate(bodies, facets, "fwd");
      const schema = schemaBlock(forward);
      const usages = usageClasses(forward);

      for (const [field, kinds] of usages) {
        const scalar = kinds.has("scalar");
        expect(scalar && (kinds.has("indexed") || kinds.has("wholesale")), `${field} mixes shapes`)
          .toBe(false);
        const declared = declaredShape(schema, field);
        expect(declared, `${field} has no schema entry\n${forward}`).not.toBe("");
        if (scalar) {
          expect(declared, `${field} spliced as scalar`).toMatch(/z\.string\(\)/);
        } else {
          expect(declared, `${field} used as array/object`).not.toMatch(/z\.string\(\)\s*[,.]?\s*(?:\/\/.*)?$/);
        }
      }

      const reversed = generate([...bodies].reverse(), [...facets].reverse(), "rev");
      expect(shapeSignature(reversed)).toEqual(shapeSignature(forward));
    },
    120_000
  );
});
