import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Pins facet binding completeness: six declared navigateTo payloadField facets,
 * three of whose hash fragments differ from their body literals (unreachable by
 * identity), are each spliced as `payload.<field>` at every call site, with no
 * surviving literal and no whole-array passthrough. Generic retail fixture.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.array-facet-complete-binding-fixture.example.com";
const DELIMITER = ";kind=slug";
const SITE_PATHS = ["/shop/find-a/", "/shop/find-b/", "/shop/find-c/"];

const REACHABLE = {
  CityFacet: "cityx-shop-8001",
  BrandFacet: "brandx-shop-8002",
  ColorFacet: "colorx-shop-8003",
  SizeFacet: "sizex-shop-8004",
  GenderFacet: "genderx-shop-8005",
} as const;
const UNREACHABLE = {
  CodeFacet: { hash: "hashx-code-9001", body: "bodyx-code-7001" },
} as const;
const OPTIONAL_FIELDS = ["SizeFacet", "CodeFacet"];

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
    bodies.set(url, chunk.slice(bodyStart, chunk.indexOf("`,\n      schema:")));
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

describe("recon-generate CLI — complete facet binding at every site", () => {
  it("splices all six facets, including unreachable positional ones, at every call site", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-array-facet-complete-binding-"));
    const runRoot = join(workDir, "run");
    mkdirSync(join(runRoot, "graphql"), { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));

    const [city, brand, color, size, gender] = Object.values(REACHABLE).map(tagged);
    const [code] = Object.values(UNREACHABLE).map((u) => tagged(u.body));
    const bodies: unknown[] = [
      { filters: ["type=any", city, brand, color, size, gender, "currency=usd"] },
      { filters: [city, brand, color, size, gender, code], refine: true },
      { filters: ["sort=price", city, brand, color, size, gender, code, "page=1"] },
    ];
    bodies.forEach((body, index) => {
      const capture = buildCapture({
        url: `https://${OWN_BACKEND_HOST}${SITE_PATHS[index]}`,
        requestPostData: JSON.stringify(body),
        responseBody: { ok: true },
        timestamp: `2026-06-01T00:00:0${index}.000Z`,
      });
      writeFileSync(
        join(runRoot, "graphql", `${String(index).padStart(3, "0")}-capture.json`),
        JSON.stringify(capture)
      );
    });

    const siteId = `array-facet-complete-binding-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    const base = `https://${OWN_BACKEND_HOST}/#/shop`;
    const hashTokens = [
      ...Object.values(REACHABLE),
      ...Object.values(UNREACHABLE).map((u) => u.hash),
    ];
    const fields = [...Object.keys(REACHABLE), ...Object.keys(UNREACHABLE)];
    const steps = fields.map((field, index) => ({
      step: `navigate with ${field} applied`,
      navigateTo: `${base}/${hashTokens.slice(0, index + 1).join("/")}`,
      payloadField: field,
      ...(OPTIONAL_FIELDS.includes(field) ? { optional: true } : {}),
    }));
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [...steps, { step: "search shop", submitStep: true }],
        submitEndpointPattern: "shop/find-c",
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
    const callBodies = extractCallSiteBodies(contract);

    expect(callBodies.size).toBe(SITE_PATHS.length);
    for (const token of hashTokens) expect(contract).not.toContain(token);
    for (const u of Object.values(UNREACHABLE)) expect(contract).not.toContain(u.body);
    expect(contract).not.toMatch(/JSON\.stringify\(payload\.filters\)/);
    expect(contract).not.toMatch(/payload\.filters\[/);

    for (const path of SITE_PATHS) {
      const body = callBodies.get(path);
      expect(body, contract).toBeDefined();
      for (const field of path === SITE_PATHS[0] ? fields.slice(0, -1) : fields) {
        expect(body, `${path} missing ${field}`).toContain(`payload.${field}`);
      }
      for (const field of OPTIONAL_FIELDS.filter(
        (f) => path !== SITE_PATHS[0] || f !== "CodeFacet"
      )) {
        expect(body).toContain(`...(payload.${field} ? [`);
      }
    }
    expect(callBodies.get(SITE_PATHS[0] ?? "")).not.toContain("payload.CodeFacet");
    expect(callBodies.get(SITE_PATHS[0] ?? "")).toContain("type=any");
    expect(callBodies.get(SITE_PATHS[2] ?? "")).toContain("page=1");
  }, 30_000);
});
