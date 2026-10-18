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

const OWN_BACKEND_HOST = "www.click-unobserved-kind-facet-fixture.example.com";

function step(label: string, option: string): string {
  return `Open the ${label} filter dropdown in the quote bar and select the '${option}' option, keeping the other filters that are already applied`;
}

const FIVE_ELEMENTS = [
  "2026-12;filterType=date",
  "BAHAMAS;filterType=destination",
  "MERRY;filterType=theme",
  "WW;filterType=ship",
  "GOC;filterType=privateIsland",
];

const OBSERVED_STEPS = [
  { step: step("departure date", "2026-12"), payloadField: "date" },
  { step: step("destination", "Bahamas"), payloadField: "destination" },
  { step: step("theme", "Merry"), payloadField: "theme" },
  { step: step("ship", "WW"), payloadField: "ship" },
];
const NIGHTS_STEP = {
  step: step("cruise length (number of nights)", "4"),
  payloadField: "nights",
};
const CLICK_STEPS = [...OBSERVED_STEPS, NIGHTS_STEP];

function buildCaptures(): Capture[] {
  const bodies: Array<[string, unknown]> = [
    ["/quote/", { filters: FIVE_ELEMENTS }],
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

function generate(): { contract: string; browserFlow: string; output: string } {
  workDir = mkdtempSync(join(tmpdir(), "barnacle-click-unobserved-kind-facet-"));
  const runRoot = join(workDir, "run");
  mkdirSync(join(runRoot, "graphql"), { recursive: true });
  mkdirSync(join(runRoot, "replays"), { recursive: true });
  mkdirSync(join(runRoot, "aux"), { recursive: true });
  writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
  buildCaptures().forEach((capture, index) => {
    writeFileSync(
      join(runRoot, "graphql", `${String(index).padStart(3, "0")}-capture.json`),
      JSON.stringify(capture)
    );
  });

  const siteId = `click-unobserved-kind-facet-test-${process.pid}`;
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

describe("recon-generate CLI — click facet of a kind absent from the captured array", () => {
  it("never leaves a declared field required yet referenced zero times", () => {
    const { contract, browserFlow, output } = generate();
    const unreferenced = unreferencedDeclaredPayloadFields(contract, browserFlow, CLICK_STEPS);
    for (const field of unreferenced) {
      expect(contract, `${field} unreferenced must be optional\n${output}`).toMatch(
        new RegExp(`${field}: z\\.string\\(\\)\\.optional\\(\\)`)
      );
    }
    expect(unreferenced).not.toEqual(expect.arrayContaining(["destination", "theme", "ship"]));
  }, 60_000);

  it("keeps observed siblings threaded in the filters array", () => {
    const { contract, output } = generate();
    for (const kind of ["destination", "theme", "ship", "date"]) {
      expect(contract, output).toMatch(new RegExp(`payload\\.${kind}[^\\x60]*;filterType=${kind}`));
    }
    expect(contract).not.toContain("BAHAMAS;filterType=destination");
    expect(contract).not.toMatch(/payload\.nights[^\x60]*;filterType=(?!night)/);
  }, 60_000);
});
