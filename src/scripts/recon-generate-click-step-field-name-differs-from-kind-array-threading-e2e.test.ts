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

const OWN_BACKEND_HOST = "www.click-field-differs-from-kind-fixture.example.com";

const DESTINATION_STEP =
  "Open the destination filter dropdown in the quote bar and select the 'Bahamas' destination option, keeping the other filters that are already applied";
const NIGHTS_STEP =
  "Open the cruise length (number of nights) filter dropdown in the quote bar and select the '4' nights option, keeping the other filters that are already applied";

const FIVE_ELEMENTS = [
  "2026-12;filterType=date",
  "BAHAMAS;filterType=destination",
  "MERRY;filterType=theme",
  "WW;filterType=ship",
  "GOC;filterType=privateIsland",
];
const SIX_ELEMENTS = [...FIVE_ELEMENTS, "4;filterType=night"];

const CLICK_STEPS = [
  { step: DESTINATION_STEP, payloadField: "destination" },
  { step: NIGHTS_STEP, payloadField: "nights" },
];

/**
 * Slug-vocabulary bodies plus one quote body whose filters array is made only
 * of CODE;filterType=<kind> elements, so only click-step facets can govern it.
 */
function buildCaptures(elements: string[]): Capture[] {
  const bodies: Array<[string, unknown]> = [
    [
      "/listing/search/",
      { filters: ["bahamas;filterId=slug", "family-fun;filterId=slug", "4-nights;filterId=slug"] },
    ],
    ["/quote/", { filters: elements }],
    ["/submit/", { confirm: true }],
  ];
  return bodies.map(([path, body], index) =>
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}${path}`,
      requestPostData: JSON.stringify(body),
      responseBody: { ok: true },
      timestamp: `2026-01-01T00:00:0${index}.000Z`,
    })
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

function generate(elements: string[]): { contract: string; browserFlow: string; output: string } {
  workDir = mkdtempSync(join(tmpdir(), "barnacle-click-field-differs-kind-"));
  const runRoot = join(workDir, "run");
  mkdirSync(join(runRoot, "graphql"), { recursive: true });
  mkdirSync(join(runRoot, "replays"), { recursive: true });
  mkdirSync(join(runRoot, "aux"), { recursive: true });
  writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
  buildCaptures(elements).forEach((capture, index) => {
    writeFileSync(
      join(runRoot, "graphql", `${String(index).padStart(3, "0")}-capture.json`),
      JSON.stringify(capture)
    );
  });

  const siteId = `click-field-differs-kind-test-${process.pid}`;
  siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({
      steps: [...CLICK_STEPS, { step: "submit the quote", submitStep: true }],
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
  const output = `${result.stdout}\n${result.stderr}`;
  expect(result.status, output).toBe(0);
  return {
    contract: readFileSync(join(siteOutDir, "contract.ts"), "utf8"),
    browserFlow: readFileSync(join(siteOutDir, "flows", "browser-flow.ts"), "utf8"),
    output,
  };
}

describe("recon-generate CLI — click-step facets whose field name differs from the element kind", () => {
  it("threads destination in the five-element array and leaves no frozen element literal", () => {
    const { contract, browserFlow, output } = generate(FIVE_ELEMENTS);
    expect(contract, contract).toMatch(/payload\.destination[^\x60]*;filterType=destination/);
    expect(contract, contract).not.toContain("BAHAMAS;filterType=destination");
    expect(
      unreferencedDeclaredPayloadFields(contract, browserFlow, CLICK_STEPS.slice(0, 1)),
      output
    ).toEqual([]);
  }, 60_000);

  it("binds nights to the filterType=night element and threads both facets in the six-element array", () => {
    const { contract, browserFlow, output } = generate(SIX_ELEMENTS);
    expect(contract, contract).toMatch(/payload\.destination[^\x60]*;filterType=destination/);
    expect(contract, contract).toMatch(/payload\.nights[^\x60]*;filterType=night/);
    expect(contract, contract).not.toContain("BAHAMAS;filterType=destination");
    expect(contract, contract).not.toContain("4;filterType=night");
    expect(unreferencedDeclaredPayloadFields(contract, browserFlow, CLICK_STEPS), output).toEqual(
      []
    );
  }, 60_000);
});
