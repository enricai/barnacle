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

const OWN_BACKEND_HOST = "www.rental-listings-quote-bar-fixture.example.com";

const DESTINATION_STEP =
  "Open the destination filter dropdown in the quote bar and select the 'Lakeside' destination option, keeping the other filters that are already applied";
const NIGHTS_STEP =
  "Open the length of stay (number of nights) filter dropdown in the quote bar and select the '4' nights option, keeping the other filters that are already applied";

const SIX_ELEMENTS = [
  "2026-12;filterType=date",
  "LK;filterType=destination",
  "SP;filterType=theme",
  "HB;filterType=ship",
  "GC;filterType=hiddenCove",
  "4;filterType=night",
];

const DECLARED_STEPS = [
  { step: "navigate to the ship page", payloadField: "ship" },
  { step: "navigate to the trip's month", payloadField: "tripMonth" },
  { step: "navigate to the theme page", payloadField: "theme" },
  { step: "navigate to the hidden cove page", payloadField: "hiddenCove" },
  { step: DESTINATION_STEP, payloadField: "destination" },
  { step: NIGHTS_STEP, payloadField: "nights" },
];

const VOCABULARIES = [
  { label: "slug", filterId: "slug" },
  { label: "code", filterId: "urlFriendlyId" },
];

function buildCaptures(filterId: string): Capture[] {
  const bodies: Array<[string, unknown]> = [
    [
      "/browse/",
      {
        ids: [
          `west-hub;filterId=${filterId}`,
          `december-2026;filterId=${filterId}`,
          `festive-season;filterId=${filterId}`,
          `palm-cay;filterId=${filterId}`,
        ],
      },
    ],
    ["/quote/", { filters: SIX_ELEMENTS }],
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

function generate(
  label: string,
  filterId: string
): { contract: string; browserFlow: string; output: string } {
  workDir = mkdtempSync(join(tmpdir(), `barnacle-quote-bar-array-${label}-`));
  const runRoot = join(workDir, "run");
  writeRunDir(runRoot, buildCaptures(filterId));

  const siteId = `quote-bar-array-${label}-test-${process.pid}`;
  siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
  mkdirSync(siteOutDir, { recursive: true });
  const hash = `https://${OWN_BACKEND_HOST}/#`;
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({
      steps: [
        {
          step: "navigate to the ship page",
          navigateTo: `${hash}/ship/west-hub`,
          payloadField: "ship",
        },
        {
          step: "navigate to the trip's month",
          navigateTo: `${hash}/ship/west-hub/december-2026`,
          payloadField: "tripMonth",
        },
        {
          step: "navigate to the theme page",
          navigateTo: `${hash}/theme/festive-season`,
          payloadField: "theme",
        },
        {
          step: "navigate to the hidden cove page",
          navigateTo: `${hash}/island/palm-cay`,
          payloadField: "hiddenCove",
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

describe("recon-generate CLI — quote-bar click-step facets spliced into a kind-suffixed array", () => {
  for (const { label, filterId } of VOCABULARIES) {
    it(`splices destination and nights in captured order and keeps no literal (${label} vocabulary)`, () => {
      const { contract, browserFlow } = generate(label, filterId);

      expect(contract, contract).toMatch(/payload\.destination[^\x60]*;filterType=destination/);
      expect(contract, contract).toMatch(/payload\.nights[^\x60]*;filterType=night/);
      for (const element of SIX_ELEMENTS) {
        expect(contract, contract).not.toContain(element);
      }

      const order = SIX_ELEMENTS.map((e) => contract.indexOf(`;${e.split(";")[1]}`));
      expect(
        order.every((at) => at >= 0),
        contract
      ).toBe(true);
      expect(order).toEqual([...order].sort((a, b) => a - b));

      expect(unreferencedDeclaredPayloadFields(contract, browserFlow, DECLARED_STEPS)).toEqual([]);
    }, 60_000);
  }
});
