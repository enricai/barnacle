import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Pins the structural invariant that every `payload.<f>[...]` accessor in the
 * emitted contract text is backed by a schema declaring `f` as a structured
 * type (never a bare z.string()), across several array/facet fixture shapes.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");
const HOST = "www.accessor-schema-structural-parity-fixture.example.com";
const DELIMITER = ";kind=slug";

interface ParityCase {
  name: string;
  bodies: unknown[];
  facets: Array<{ payloadField: string; token: string }>;
  indexed: boolean;
}

const CASES: ParityCase[] = [
  {
    name: "object-array field recurring at two sites with a facet element",
    indexed: true,
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
    name: "string-array filters at three sites with differing positions",
    indexed: false,
    facets: [
      { payloadField: "CityFacet", token: "cityx-shop-8001" },
      { payloadField: "BrandFacet", token: "brandx-shop-8002" },
    ],
    bodies: [
      { filters: ["type=any", `cityx-shop-8001${DELIMITER}`, `brandx-shop-8002${DELIMITER}`] },
      { filters: [`cityx-shop-8001${DELIMITER}`, `brandx-shop-8002${DELIMITER}`], refine: true },
      { filters: ["sort=price", `cityx-shop-8001${DELIMITER}`, `brandx-shop-8002${DELIMITER}`] },
    ],
  },
  {
    name: "object-array field without any facet",
    indexed: false,
    facets: [],
    bodies: [
      {
        sorts: [
          { field: "price", direction: "asc" },
          { field: "name", direction: "desc" },
        ],
      },
      {
        sorts: [
          { field: "price", direction: "asc" },
          { field: "name", direction: "desc" },
        ],
      },
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

function indexedAccessorFields(contract: string): Set<string> {
  return new Set([...contract.matchAll(/payload\.(\w+)(?:!|\?)?\[/g)].map((m) => m[1] ?? ""));
}

function wholeArrayFields(contract: string): Set<string> {
  return new Set(
    [...contract.matchAll(/JSON\.stringify\(payload\.(\w+)\)/g)].map((m) => m[1] ?? "")
  );
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate CLI — indexed accessor / schema structural parity", () => {
  it.each(CASES)(
    "$name",
    ({ bodies, facets, indexed }) => {
      workDir = mkdtempSync(join(tmpdir(), "barnacle-accessor-schema-parity-"));
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

      const siteId = `accessor-schema-structural-parity-test-${process.pid}`;
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
          submitEndpointPattern: `shop/site-${bodies.length - 1}`,
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
      const schema = schemaBlock(contract);
      const fields = new Set([...indexedAccessorFields(contract), ...wholeArrayFields(contract)]);
      if (indexed) expect(indexedAccessorFields(contract).size, contract).toBeGreaterThan(0);
      for (const field of fields) {
        expect(schema, `${field} accessor has no schema entry`).toMatch(
          new RegExp(`\\b${field}:[^\\n]*z\\.`)
        );
        expect(schema, `${field} indexed but declared as a string`).not.toMatch(
          new RegExp(`\\b${field}:\\s*z\\.string\\(\\)`)
        );
      }
    },
    60_000
  );
});
