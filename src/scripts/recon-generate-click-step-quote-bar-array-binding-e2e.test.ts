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

const OWN_BACKEND_HOST = "www.click-quote-bar-array-fixture.example.com";

const DESTINATION_STEP =
  "Open the destination filter dropdown in the quote bar and select the 'Garden' destination option, keeping the other filters that are already applied";
const NIGHTS_STEP =
  "Open the stay length (number of nights) filter dropdown in the quote bar and select the '4' nights option, keeping the other filters that are already applied";
const ROOM_STEP =
  "Open the room type filter dropdown in the quote bar and select the 'Suite' room option, keeping the other filters that are already applied";
const UNMATCHED_STEP =
  "Open the amenity filter dropdown in the quote bar and select the 'Spa' amenity option, keeping the other filters that are already applied";

const FIVE_ELEMENTS = [
  "2026-12;filterType=date",
  "BS;filterType=destination",
  "WW;filterType=ship",
  "STE;filterType=roomType",
  "GOC;filterType=port",
];
const SIX_ELEMENTS = [...FIVE_ELEMENTS, "4;filterType=night"];

interface Facet {
  field: string;
  step: string;
  kind: string;
  gone: string;
}

const DESTINATION: Facet = {
  field: "destination",
  step: DESTINATION_STEP,
  kind: "destination",
  gone: "BS;filterType=destination",
};
const NIGHTS: Facet = {
  field: "nights",
  step: NIGHTS_STEP,
  kind: "night",
  gone: "4;filterType=night",
};
const ROOM: Facet = {
  field: "room",
  step: ROOM_STEP,
  kind: "roomType",
  gone: "STE;filterType=roomType",
};

/**
 * Acceptance surface for click-step facets: a flow whose only payloadFields
 * sit on click steps, against a captured body with no slug-bearing sibling
 * request, must still splice each facet into the element of its own kind.
 */
function buildCaptures(filters: string[]): Capture[] {
  return [
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/quote/`,
      requestPostData: JSON.stringify({ filters }),
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
  facets: Facet[]
): { contract: string; browserFlow: string; output: string } {
  workDir = mkdtempSync(join(tmpdir(), "barnacle-click-quote-bar-array-"));
  const runRoot = join(workDir, "run");
  writeRunDir(runRoot, buildCaptures(filters));

  const siteId = `click-quote-bar-array-test-${process.pid}`;
  siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({
      steps: [
        ...facets.map((facet) => ({ step: facet.step, payloadField: facet.field })),
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

function facetElement(field: string, kind: string): RegExp {
  return new RegExp(`payload\\.${field}[^\\x60]*;filterType=${kind}`);
}

function expectThreaded(contract: string, facets: Facet[]): void {
  for (const facet of facets) {
    expect(contract, contract).toMatch(facetElement(facet.field, facet.kind));
    expect(contract, contract).not.toContain(facet.gone);
  }
}

describe("recon-generate CLI — click-step facets in a kind-suffixed array with no slug body", () => {
  it("threads destination and nights into their own elements of a six-element array", () => {
    const facets = [DESTINATION, NIGHTS];
    const { contract, browserFlow } = generate(SIX_ELEMENTS, facets);

    expectThreaded(contract, facets);
    expect(
      unreferencedDeclaredPayloadFields(
        contract,
        browserFlow,
        facets.map((facet) => ({ step: facet.step, payloadField: facet.field }))
      )
    ).toEqual([]);
  }, 30_000);

  it("threads the destination facet of a five-element array without a nights element", () => {
    const { contract } = generate(FIVE_ELEMENTS, [DESTINATION]);

    expectThreaded(contract, [DESTINATION]);
  }, 30_000);

  it("threads another literal of another kind alongside destination", () => {
    const facets = [DESTINATION, ROOM];
    const { contract } = generate(FIVE_ELEMENTS, facets);

    expectThreaded(contract, facets);
  }, 30_000);

  it("keeps the captured element order", () => {
    const { contract } = generate(SIX_ELEMENTS, [DESTINATION, NIGHTS]);
    const order = [";filterType=date", ";filterType=destination", ";filterType=night"].map((kind) =>
      contract.indexOf(kind)
    );

    expect(
      order.every((at) => at >= 0),
      contract
    ).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  }, 30_000);

  it("leaves a quoted literal that matches no element out of the array", () => {
    const { contract, output } = generate(SIX_ELEMENTS, [
      DESTINATION,
      { field: "amenity", step: UNMATCHED_STEP, kind: "amenity", gone: "Spa" },
    ]);

    expectThreaded(contract, [DESTINATION]);
    expect(contract).not.toMatch(facetElement("amenity", "amenity"));
    expect(output).toContain("declared payloadField amenity is read by no emitted request");
  }, 30_000);
});
