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

const OWN_BACKEND_HOST = "www.click-step-unobserved-facet-optional-e2e-fixture.example.com";

const FOUR_ELEMENTS = [
  "GADGETS;filterType=category",
  "RED;filterType=color",
  "BETA;filterType=theme",
  "GAMMA;filterType=vendor",
];

const COLOR_STEP =
  "Open the colour filter dropdown in the sidebar and click the 'Red' colour option, keeping the other filters that are already applied";
const WARRANTY_STEP =
  "Open the warranty length filter dropdown in the sidebar and click the '24' months option, keeping the other filters that are already applied";

const DECLARED_STEPS = [
  { step: "navigate", payloadField: "category" },
  { step: COLOR_STEP, payloadField: "color" },
  { step: WARRANTY_STEP, payloadField: "warranty" },
];

function buildCaptures(): Capture[] {
  return [
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/browse/`,
      requestPostData: JSON.stringify({ sort: "recent" }),
      responseBody: { ok: true },
      timestamp: "2026-01-01T00:00:00.000Z",
    }),
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/quote/`,
      requestPostData: JSON.stringify({ category: "gadgets", filters: FOUR_ELEMENTS }),
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

function generate(): { contract: string; browserFlow: string; output: string } {
  workDir = mkdtempSync(join(tmpdir(), "barnacle-click-unobserved-facet-e2e-"));
  const runRoot = join(workDir, "run");
  for (const dir of ["graphql", "replays", "aux"])
    mkdirSync(join(runRoot, dir), { recursive: true });
  writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
  buildCaptures().forEach((capture, index) => {
    writeFileSync(
      join(runRoot, "graphql", `${String(index).padStart(3, "0")}-capture.json`),
      JSON.stringify(capture)
    );
  });

  const siteId = `click-step-unobserved-facet-optional-e2e-test-${process.pid}`;
  siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({
      steps: [
        {
          step: "navigate to the gadgets category page",
          navigateTo: `https://${OWN_BACKEND_HOST}/#/browse/gadgets`,
          payloadField: "category",
        },
        { step: COLOR_STEP, payloadField: "color" },
        { step: WARRANTY_STEP, payloadField: "warranty" },
        { step: "submit the quote", submitStep: true },
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
  return {
    contract: readFileSync(join(siteOutDir, "contract.ts"), "utf8"),
    browserFlow: readFileSync(join(siteOutDir, "flows", "browser-flow.ts"), "utf8"),
    output,
  };
}

describe("recon-generate CLI — click facet whose literal is in no capture", () => {
  it("warns about the unobserved click facet but not the threaded one", () => {
    const { output } = generate();

    expect(output).toContain("declared payloadField warranty is read by no emitted request");
    expect(output).not.toContain("declared payloadField color is read by no emitted request");
    expect(output).not.toContain("declared payloadField category is read by no emitted request");
  }, 30_000);

  it("emits the unobserved facet optional and threads the observed sibling", () => {
    const { contract, browserFlow } = generate();

    expect(contract).toMatch(/warranty: z\.string\(\)\.optional\(\)/);
    expect(contract).not.toMatch(/warranty: z\.string\(\)(?!\.optional)/);
    expect(contract).not.toContain("payload.warranty");
    expect(contract, contract).toMatch(/payload\.color[^`]*;filterType=color/);
    expect(
      unreferencedDeclaredPayloadFields(contract, "", DECLARED_STEPS),
      "warranty appears in no request and no flow text"
    ).toEqual(["warranty"]);
    expect(unreferencedDeclaredPayloadFields(contract, browserFlow, DECLARED_STEPS)).not.toContain(
      "color"
    );
  }, 30_000);
});
