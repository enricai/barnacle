import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { unreferencedDeclaredPayloadFields } from "@/scripts/recon-generate";
import { RECON_GENERATE_CWD } from "@/scripts/recon-generate-cwd.test-helper";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.click-step-filtertype-acceptance-fixture.example.com";

const CATEGORY_STEP =
  "Open the category filter dropdown in the quote bar and select the 'Shoes' category option, keeping the other filters that are already applied";
const NIGHTS_STEP =
  "Open the nights filter dropdown in the quote bar and select the '4' nights option, keeping the other filters that are already applied";

const SIX_ELEMENTS = [
  "2026-12;filterType=release",
  "SH;filterType=category",
  "WP;filterType=feature",
  "4;filterType=night",
  "LT;filterType=weight",
  "EU;filterType=market",
];
const NO_NIGHT_ELEMENTS = SIX_ELEMENTS.filter((e) => !e.endsWith("=night"));

const FLOW_STEPS = [
  { step: CATEGORY_STEP, payloadField: "destination" },
  { step: NIGHTS_STEP, payloadField: "nights" },
  { step: "submit the quote", submitStep: true },
];

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

function generate(elements: string[]): { contract: string; browserFlow: string; output: string } {
  workDir = mkdtempSync(join(tmpdir(), "barnacle-click-filtertype-acceptance-"));
  const runRoot = join(workDir, "run");
  for (const dir of ["graphql", "replays", "aux"])
    mkdirSync(join(runRoot, dir), { recursive: true });
  writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
  const bodies: Array<[string, unknown]> = [
    ["/quote/", { filters: elements }],
    ["/submit/", { confirm: true }],
  ];
  bodies.forEach(([path, body], index) => {
    const capture = buildCapture({
      url: `https://${OWN_BACKEND_HOST}${path}`,
      requestPostData: JSON.stringify(body),
      responseBody: { ok: true },
      timestamp: `2026-01-01T00:00:0${index}.000Z`,
    });
    writeFileSync(
      join(runRoot, "graphql", `${String(index).padStart(3, "0")}-capture.json`),
      JSON.stringify(capture)
    );
  });

  const siteId = `click-step-filtertype-acceptance-test-${process.pid}`;
  siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({
      steps: FLOW_STEPS,
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

describe("recon-generate CLI — click-step facets in a kind-suffixed array", () => {
  it("splices destination and nights into their filterType elements when night is captured", () => {
    const { contract, browserFlow, output } = generate(SIX_ELEMENTS);

    const declared = FLOW_STEPS.filter((s) => s.payloadField).map((s) => ({
      step: s.step,
      payloadField: s.payloadField as string,
    }));
    expect(unreferencedDeclaredPayloadFields(contract, browserFlow, declared), output).toEqual([]);

    expect(contract, contract).toMatch(/payload\.destination[^\x60]*;filterType=category/);
    expect(contract, contract).toMatch(/payload\.nights[^\x60]*;filterType=night/);
    expect(contract, contract).not.toContain("SH;filterType=category");
    expect(contract, contract).not.toContain("4;filterType=night");
    expect(contract, contract).toMatch(/^\s*nights: z\.string\(\),/m);
    const order = SIX_ELEMENTS.map((e) => contract.indexOf(`;filterType=${e.split("=")[1]}`));
    expect(
      order.every((i) => i >= 0),
      contract
    ).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  }, 60_000);

  it("makes nights optional and warns when no night element is captured", () => {
    const { contract, output } = generate(NO_NIGHT_ELEMENTS);

    expect(contract, contract).toMatch(/payload\.destination[^\x60]*;filterType=category/);
    expect(contract, contract).not.toMatch(/^\s*nights: z\.string\(\),/m);
    expect(output).toMatch(/declared payloadField nights is read by no emitted request/);
  }, 60_000);
});
