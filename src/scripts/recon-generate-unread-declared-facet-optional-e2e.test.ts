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

const OWN_BACKEND_HOST = "www.unread-declared-facet-optional-e2e-fixture.example.com";

const FIVE_ELEMENTS = [
  "2026-12;filterType=date",
  "PARIS;filterType=destination",
  "BETA;filterType=theme",
  "GAMMA;filterType=vendor",
  "DELTA;filterType=extra",
];

const DESTINATION_STEP =
  "Open the destination filter dropdown in the search bar and select the 'Paris' destination option, keeping the other filters that are already applied";
const NIGHTS_STEP =
  "Open the length of stay (number of nights) filter dropdown in the search bar and select the '4' nights option, keeping the other filters that are already applied";

const REGION_STEP = "navigate to the EMEA region page";

const DECLARED_STEPS = [
  { step: "navigate", payloadField: "category" },
  { step: REGION_STEP, payloadField: "region" },
  { step: DESTINATION_STEP, payloadField: "destination" },
  { step: NIGHTS_STEP, payloadField: "nights" },
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
      requestPostData: JSON.stringify({ category: "gadgets", filters: FIVE_ELEMENTS }),
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
  workDir = mkdtempSync(join(tmpdir(), "barnacle-unread-declared-facet-e2e-"));
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

  const siteId = `unread-declared-facet-optional-e2e-test-${process.pid}`;
  siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
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
        {
          step: REGION_STEP,
          navigateTo: `https://${OWN_BACKEND_HOST}/#/browse/gadgets/emea`,
          payloadField: "region",
        },
        { step: DESTINATION_STEP, payloadField: "destination" },
        { step: NIGHTS_STEP, payloadField: "nights" },
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

describe("recon-generate CLI — declared facets with no request evidence", () => {
  it("warns about the unread click and navigateTo facets, but not the threaded destination", () => {
    const { output } = generate();

    expect(output).toContain("declared payloadField nights is read by no emitted request");
    expect(output).toContain("declared payloadField region is read by no emitted request");
    expect(output).not.toContain("declared payloadField destination is read by no emitted request");
    expect(output).not.toContain("declared payloadField category is read by no emitted request");
  }, 30_000);

  it("reports unread facets in the review checklist, but not threaded ones", () => {
    const { output } = generate();

    expect(output).toContain("[ ] Declared payloadField nights is read by no emitted request");
    expect(output).toContain("[ ] Declared payloadField region is read by no emitted request");
    expect(output).not.toContain("Declared payloadField destination is read by no emitted request");
    expect(output).not.toContain("Declared payloadField category is read by no emitted request");
  }, 30_000);

  it("emits unread facets optional, keeps threaded facets threaded, and falls back in the browser flow", () => {
    const { contract, browserFlow } = generate();

    expect(contract).toMatch(/nights: z\.string\(\)\.optional\(\)/);
    expect(contract).toMatch(/region: z\.string\(\)\.optional\(\)/);
    expect(contract).not.toContain("payload.nights");
    expect(contract).not.toContain("payload.region");
    expect(contract, contract).toMatch(/payload\.destination[^`]*;filterType=destination/);
    expect(contract).toContain("payload.category");
    expect(browserFlow).toContain('payload.nights ?? "4"');
    expect(
      unreferencedDeclaredPayloadFields(contract, browserFlow, DECLARED_STEPS),
      "navigateTo steps are never spliced into the browser flow, so only region stays unread; it is optional and warned"
    ).toEqual(["region"]);
    expect(
      unreferencedDeclaredPayloadFields(
        contract,
        browserFlow,
        DECLARED_STEPS.filter((step) => step.payloadField !== "region")
      ),
      "the click-declared nights facet is read by the browser flow fallback, so no other declared facet is unreferenced"
    ).toEqual([]);
  }, 30_000);
});
