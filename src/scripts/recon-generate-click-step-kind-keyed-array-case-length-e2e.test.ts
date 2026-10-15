import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { unreferencedDeclaredPayloadFields } from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.kind-keyed-case-length-fixture.example.com";

const CATEGORY_STEP =
  "Open the category filter dropdown in the catalogue toolbar and select the 'Shoes' category option, keeping the other filters that are already applied";
const SIZE_STEP =
  "Open the size (number of units) filter dropdown in the catalogue toolbar and select the '4' size option, keeping the other filters that are already applied";

function buildCaptures(filters: string[]): Capture[] {
  return [
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/browse/`,
      requestPostData: JSON.stringify({ sort: "recent" }),
      responseBody: { ok: true },
      timestamp: "2026-01-01T00:00:00.000Z",
    }),
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/catalogue/`,
      requestPostData: JSON.stringify({ section: "gadgets", pageSize: 4, filters }),
      responseBody: { ok: true },
      timestamp: "2026-01-01T00:00:01.000Z",
    }),
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/submit/`,
      requestPostData: JSON.stringify({ confirm: true }),
      responseBody: { ok: true },
      timestamp: "2026-01-01T00:00:02.000Z",
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

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

function generate(
  filters: string[],
  steps: { step: string; payloadField: string }[]
): { contract: string; output: string } {
  workDir = mkdtempSync(join(tmpdir(), "barnacle-kind-keyed-case-length-"));
  const runRoot = join(workDir, "run");
  writeRunDir(runRoot, buildCaptures(filters));

  const siteId = `kind-keyed-case-length-test-${process.pid}`;
  siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({
      steps: [
        {
          step: "navigate to the gadgets section page",
          navigateTo: `https://${OWN_BACKEND_HOST}/#/browse/gadgets`,
          payloadField: "section",
        },
        ...steps,
        { step: "submit the order", submitStep: true },
      ],
      submitEndpointPattern: "submit",
      requireSubmitEndpointMatch: true,
      ownBackendHostnames: [OWN_BACKEND_HOST],
    })
  );

  const result = spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
  const output = `${result.stdout}\n${result.stderr}`;
  expect(result.status, output).toBe(0);
  return { contract: readFileSync(join(siteOutDir, "contract.ts"), "utf8"), output };
}

describe("recon-generate CLI — click-step facets with case/length-divergent codes in a kind-suffixed array", () => {
  it("splices both facets as conditional spreads in element order with no frozen element left", () => {
    const steps = [
      { step: CATEGORY_STEP, payloadField: "categories" },
      { step: SIZE_STEP, payloadField: "sizes" },
    ];
    const { contract } = generate(
      [
        "2026-12;filterType=date",
        "SHO;filterType=category",
        "04;filterType=size",
        "WW;filterType=warehouse",
      ],
      steps
    );

    expect(contract, contract).toMatch(/payload\.categories[^`]*;filterType=category/);
    expect(contract, contract).toMatch(/payload\.sizes[^`]*;filterType=size/);
    expect(contract.indexOf("payload.categories")).toBeLessThan(contract.indexOf("payload.sizes"));
    expect(contract).not.toContain("SHO;filterType=category");
    expect(contract).not.toContain("04;filterType=size");
    expect(contract).toContain("2026-12;filterType=date");
    expect(contract).toContain("WW;filterType=warehouse");
    expect(unreferencedDeclaredPayloadFields(contract, "", steps)).toEqual([]);
  }, 30_000);
});
