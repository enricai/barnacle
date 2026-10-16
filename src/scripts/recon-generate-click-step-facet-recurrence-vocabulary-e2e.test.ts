import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { unreferencedDeclaredPayloadFields } from "@/scripts/recon-generate";
import { RECON_GENERATE_CWD } from "@/scripts/recon-generate-cwd.test-helper";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.facet-recurrence-vocabulary-fixture.example.com";

const CATEGORY_STEP =
  "Open the category filter dropdown in the search bar and select the 'Shoes' category option, keeping the other filters that are already applied";
const UNITS_STEP =
  "Open the units filter dropdown in the search bar and select the '4' nights option, keeping the other filters that are already applied";

const STEPS = [
  { step: CATEGORY_STEP, payloadField: "category" },
  { step: UNITS_STEP, payloadField: "units" },
];

const QUOTE_FILTERS = [
  "2026-12;filterType=date",
  "SH;filterType=category",
  "4;filterType=nights",
  "WW;filterType=warehouse",
];

const SUMMARY_FILTERS = ["WW;filterType=warehouse", "4;filterType=nights"];

function buildCaptures(): Capture[] {
  return [
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/quote/`,
      requestPostData: JSON.stringify({ filters: QUOTE_FILTERS }),
      responseBody: { ok: true },
      timestamp: "2026-01-01T00:00:00.000Z",
    }),
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/summary/`,
      requestPostData: JSON.stringify({ filters: SUMMARY_FILTERS }),
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

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

function generate(): string {
  workDir = mkdtempSync(join(tmpdir(), "barnacle-facet-recurrence-"));
  const runRoot = join(workDir, "run");
  for (const dir of ["graphql", "replays", "aux"]) {
    mkdirSync(join(runRoot, dir), { recursive: true });
  }
  writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
  buildCaptures().forEach((capture, index) => {
    writeFileSync(
      join(runRoot, "graphql", `${String(index).padStart(3, "0")}-capture.json`),
      JSON.stringify(capture)
    );
  });

  const siteId = `facet-recurrence-vocabulary-test-${process.pid}`;
  siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({
      steps: [...STEPS, { step: "submit the quote", submitStep: true }],
      submitEndpointPattern: "submit",
      requireSubmitEndpointMatch: true,
      ownBackendHostnames: [OWN_BACKEND_HOST],
    })
  );

  const result = spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
    { cwd: RECON_GENERATE_CWD, encoding: "utf8" }
  );
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return readFileSync(join(siteOutDir, "contract.ts"), "utf8");
}

describe("recon-generate CLI — click-step facets recur across every captured kind-keyed array", () => {
  it("replaces the element of each declared kind in every array carrying it", () => {
    const contract = generate();

    expect(contract, contract).toMatch(/payload\.category[^`]*;filterType=category/);
    expect(contract).not.toContain("SH;filterType=category");
    expect(contract).toContain("2026-12;filterType=date");
    expect(contract).toContain("WW;filterType=warehouse");
    expect(unreferencedDeclaredPayloadFields(contract, "", STEPS)).toEqual([]);
  }, 30_000);

  it("threads a field that does not name its kind into every array, never the literal", () => {
    const contract = generate();

    const threaded = contract.match(/payload\.units[^`]*;filterType=nights/g) ?? [];
    expect(threaded.length, contract).toBeGreaterThanOrEqual(2);
    expect(contract).not.toContain("4;filterType=nights");
  }, 30_000);
});
