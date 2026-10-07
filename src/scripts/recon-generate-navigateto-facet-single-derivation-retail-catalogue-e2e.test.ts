import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Locks in that emitMultiStepExecuteHttp derives bound navigateTo facets once
 * (the resolved recurring list): on a generic retail-catalogue capture every
 * facet bound in the body is also declared in the payload schema, and the
 * body references it as payload.<field>.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const HOST = "www.retail-catalogue-single-derivation-fixture.example.com";

const FACETS: ReadonlyArray<{ token: string; field: string; bodyKey: string }> = [
  { token: "footwear-mkr", field: "DepartmentFacet", bodyKey: "slotA" },
  { token: "crimson-mkr", field: "ColorFacet", bodyKey: "slotB" },
  { token: "xlarge-mkr", field: "SizeFacet", bodyKey: "slotC" },
];

function fixtureCaptures(): Capture[] {
  const filterBody: Record<string, string> = {};
  for (const facet of FACETS) filterBody[facet.bodyKey] = facet.token;
  return [
    buildCapture({
      url: `https://${HOST}/catalog/browse/`,
      requestPostData: JSON.stringify({ sort: "relevance" }),
      responseBody: { ok: true },
      timestamp: "2026-02-01T00:00:00.000Z",
    }),
    buildCapture({
      url: `https://${HOST}/catalog/filter-results/`,
      requestPostData: JSON.stringify(filterBody),
      responseBody: { ok: true },
      timestamp: "2026-02-01T00:00:01.000Z",
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

describe("recon-generate CLI — retail catalogue facets bound once", () => {
  it("declares every bound facet in the schema and references it as payload.<field> in the body", () => {
    try {
      workDir = mkdtempSync(join(tmpdir(), "barnacle-facet-single-derivation-"));
      const runRoot = join(workDir, "run");
      writeRunDir(runRoot, fixtureCaptures());

      const siteId = `facet-single-derivation-test-${process.pid}`;
      siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
      mkdirSync(siteOutDir, { recursive: true });
      writeFileSync(
        join(siteOutDir, "recon-flow.json"),
        JSON.stringify({
          steps: [
            ...FACETS.map((facet) => ({
              step: `navigate to the catalog with the ${facet.field} applied`,
              navigateTo: `https://${HOST}/shop#${facet.token}`,
              payloadField: facet.field,
            })),
            { step: "browse catalog" },
            { step: "apply filters", submitStep: true },
          ],
          submitEndpointPattern: "catalog/filter-results",
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
      const bodyBlocks = [...contract.matchAll(/body:\s*`([^`]*)`,/g)].map((m) => m[1] ?? "");
      expect(bodyBlocks.length, contract).toBeGreaterThan(0);
      const combinedBody = bodyBlocks.join("\n");

      for (const facet of FACETS) {
        expect(contract, `schema declares ${facet.field}`).toMatch(
          new RegExp(`\\b${facet.field}\\s*:`)
        );
        expect(combinedBody, `body references ${facet.field}`).toContain(
          `\${payload.${facet.field}}`
        );
        expect(combinedBody).not.toContain(facet.token);
      }
    } finally {
      if (workDir) rmSync(workDir, { recursive: true, force: true });
      if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
      workDir = null;
      siteOutDir = null;
    }
  }, 30_000);
});
