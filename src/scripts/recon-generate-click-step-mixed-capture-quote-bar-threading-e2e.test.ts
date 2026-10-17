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

const OWN_BACKEND_HOST = "www.click-mixed-capture-fixture.example.com";
const REGION_SLUG = "north-coast";
const THEME_SLUG = "family-fun";

const DESTINATION_STEP =
  "Open the destination filter dropdown in the quote bar and select the 'Garden' destination option, keeping the other filters that are already applied";
const NIGHTS_STEP =
  "Open the trip length (number of nights) filter dropdown in the quote bar and select the '4' nights option, keeping the other filters that are already applied";

const QUOTE_BAR_ELEMENTS = [
  "2026-12;filterType=date",
  "BS;filterType=destination",
  "MERRY;filterType=theme",
  "WW;filterType=ship",
  "GOC;filterType=port",
];

const FLOW_STEPS = [
  {
    step: "navigate to the listing page with the region applied",
    navigateTo: `https://${OWN_BACKEND_HOST}/#/listing/Region/${REGION_SLUG.toUpperCase()}`,
    payloadField: "RegionFacet",
  },
  {
    step: "navigate to the listing page with the theme applied",
    navigateTo: `https://${OWN_BACKEND_HOST}/#/listing/Region/${REGION_SLUG.toUpperCase()}/Theme/${THEME_SLUG}`,
    payloadField: "ThemeFacet",
    optional: true,
  },
  { step: DESTINATION_STEP, payloadField: "destination" },
  { step: NIGHTS_STEP, payloadField: "nights" },
  { step: "submit the quote", submitStep: true },
];

/**
 * Acceptance surface for the mixed capture set: slug bodies (filterId
 * vocabulary) and a quote-bar body (filterType vocabulary) in one run. A
 * payloadField declared on a click step must govern every element carrying
 * its value, and a declared field that governs nothing must not be required.
 */
function buildCaptures(): Capture[] {
  const bodies: Array<[string, unknown]> = [
    [
      "/listing/search/",
      {
        filters: [
          `${REGION_SLUG};filterId=slug`,
          `${THEME_SLUG};filterId=slug`,
          "2026-12;filterId=slug",
        ],
      },
    ],
    ["/quote/", { filters: QUOTE_BAR_ELEMENTS }],
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

describe("recon-generate CLI — click-step facets with slug bodies and a quote-bar body in one capture set", () => {
  it("governs every kind-suffixed element by its declared facet and emits no unread required field", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-click-mixed-capture-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, buildCaptures());

    const siteId = `click-mixed-capture-test-${process.pid}`;
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

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    const browserFlow = readFileSync(join(siteOutDir, "flows", "browser-flow.ts"), "utf8");

    const declared = FLOW_STEPS.filter((s) => s.payloadField).map((s) => ({
      step: s.step,
      payloadField: s.payloadField as string,
    }));
    expect(unreferencedDeclaredPayloadFields(contract, browserFlow, declared), output).toEqual([]);

    expect(contract, contract).toMatch(/payload\.destination[^\x60]*;filterType=destination/);
    expect(contract, contract).not.toMatch(/^\s*nights: z\.string\(\),/m);
    expect(contract, contract).not.toContain("BS;filterType=destination");
  }, 60_000);
});
