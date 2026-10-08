import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Pins the splice contract for an array-of-strings body field: every declared
 * navigateTo payloadField facet is emitted as `payload.<field>` in every
 * element position of the array at every call site (optional facets as
 * conditional spreads), including a site whose array is only facets and would
 * otherwise be passed whole. Generic fixture.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const HOST = "www.array-facet-uniform-splice-fixture.example.com";
const DELIMITER = ";kind=slug";
const TOKENS = {
  CategoryFacet: "catx-item-6001",
  VendorFacet: "vendx-item-6002",
  ColorFacet: "colx-item-6003",
} as const;
const OPTIONAL_FIELDS = ["ColorFacet"];
const SITE_PATHS = ["/item/find-a/", "/item/find-b/", "/item/find-c/"];

function tagged(token: string): string {
  return `${token}${DELIMITER}`;
}

function extractCallSiteBodies(contract: string): Map<string, string> {
  const bodies = new Map<string, string>();
  // biome-ignore lint/suspicious/noTemplateCurlyInString: matching against emitted source text, not a template.
  const chunks = contract.split("httpClient(`${payload.BaseUrl}").slice(1);
  for (const chunk of chunks) {
    const url = chunk.slice(0, chunk.indexOf("`,"));
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

describe("recon-generate CLI — array facet uniform splice", () => {
  it("splices every facet as payload.<field> at every site and element, including the whole-array site", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-array-facet-uniform-splice-"));
    const runRoot = join(workDir, "run");
    const t = Object.values(TOKENS).map(tagged);
    const bodies: unknown[] = [
      { terms: ["kind=all", t[0], t[1], t[2], "limit=20"] },
      { terms: [t[2], t[0], t[1]], refine: true },
      { terms: [t[1], t[2], t[0]] },
    ];
    mkdirSync(join(runRoot, "graphql"), { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
    bodies.forEach((body, index) => {
      writeFileSync(
        join(runRoot, "graphql", `${String(index).padStart(3, "0")}-capture.json`),
        JSON.stringify(
          buildCapture({
            url: `https://${HOST}${SITE_PATHS[index]}`,
            requestPostData: JSON.stringify(body),
            responseBody: { ok: true },
            timestamp: `2026-06-01T00:00:0${index}.000Z`,
          })
        )
      );
    });

    const siteId = `array-facet-uniform-splice-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    const fields = Object.keys(TOKENS) as (keyof typeof TOKENS)[];
    const steps = fields.map((field, index) => ({
      step: `navigate with ${field} applied`,
      navigateTo: `https://${HOST}/#/item/${fields
        .slice(0, index + 1)
        .map((f) => TOKENS[f])
        .join("/")}`,
      payloadField: field,
      ...(OPTIONAL_FIELDS.includes(field) ? { optional: true } : {}),
    }));
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [...steps, { step: "find items", submitStep: true }],
        submitEndpointPattern: "item/find-c",
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
    const callBodies = extractCallSiteBodies(contract);

    for (const token of Object.values(TOKENS)) {
      expect(contract).not.toContain(token);
    }
    expect(contract).not.toMatch(/JSON\.stringify\(payload\.terms\)/);
    expect(contract).not.toMatch(/payload\.terms\[/);
    expect(callBodies.size).toBe(SITE_PATHS.length);

    for (const path of SITE_PATHS) {
      const body = callBodies.get(path) ?? "";
      expect(body, contract).not.toBe("");
      for (const field of fields) {
        const occurrences = body.split(`payload.${field}`).length - 1;
        expect(occurrences, `${path} ${field}`).toBe(OPTIONAL_FIELDS.includes(field) ? 2 : 1);
      }
      expect(body).toContain(`\${payload.CategoryFacet}${DELIMITER}`);
      expect(body).toContain(`\${payload.VendorFacet}${DELIMITER}`);
      expect(body).toContain("...(payload.ColorFacet ? [");
    }
    expect(callBodies.get(SITE_PATHS[0] ?? "")).toContain("kind=all");
    expect(callBodies.get(SITE_PATHS[0] ?? "")).toContain("limit=20");
  }, 30_000);
});
