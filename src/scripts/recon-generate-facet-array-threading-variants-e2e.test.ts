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

const OWN_BACKEND_HOST = "www.facet-array-threading-variants-fixture.example.com";

type Step = { step: string; payloadField: string; navigateTo?: string };

type Variant = {
  name: string;
  filters: string[];
  steps: Step[];
  browseIds?: string[];
  threaded: Array<{ field: string; kind: string }>;
  gone: string[];
  literal: string[];
};

const clickStep = (kindLabel: string, literal: string): string =>
  `Open the ${kindLabel} filter dropdown in the search bar and select the '${literal}' option, keeping the other filters that are already applied`;

/**
 * Re-runs the click/hash facet threading assertions with other literals,
 * kinds, element order and literal-vs-code case, so the generator is shown
 * not to be keyed to a single fixture's values.
 */
const VARIANTS: Variant[] = [
  {
    name: "destination literal 'Lisbon' against element LIS;filterType=destination",
    filters: [
      "2027-03;filterType=date",
      "LIS;filterType=destination",
      "SPRING;filterType=theme",
      "5;filterType=night",
    ],
    steps: [{ step: clickStep("destination", "Lisbon"), payloadField: "destination" }],
    threaded: [{ field: "destination", kind: "destination" }],
    gone: ["LIS;filterType=destination"],
    literal: ["2027-03;filterType=date", "SPRING;filterType=theme", "5;filterType=night"],
  },
  {
    name: "nights literal '7' with the night element first",
    filters: [
      "7;filterType=night",
      "LIS;filterType=destination",
      "SPRING;filterType=theme",
      "2027-03;filterType=date",
    ],
    steps: [{ step: clickStep("length of stay (number of nights)", "7"), payloadField: "nights" }],
    threaded: [{ field: "nights", kind: "night" }],
    gone: ["7;filterType=night"],
    literal: ["LIS;filterType=destination", "SPRING;filterType=theme", "2027-03;filterType=date"],
  },
  {
    name: "step literal case differs from the element code case",
    filters: [
      "LISBON;filterType=destination",
      "SPRING;filterType=theme",
      "2027-03;filterType=date",
    ],
    steps: [{ step: clickStep("destination", "lisbon"), payloadField: "destination" }],
    threaded: [{ field: "destination", kind: "destination" }],
    gone: ["LISBON;filterType=destination"],
    literal: ["SPRING;filterType=theme", "2027-03;filterType=date"],
  },
  {
    name: "hash facet whose kind differs from its field name",
    filters: [
      "SPRING;filterType=theme",
      "EXTRA;filterType=venue",
      "CX;filterType=carrier",
      "2027-03;filterType=date",
    ],
    browseIds: ["east-hub;filterId=urlFriendlyId", "paris-trips;filterId=urlFriendlyId"],
    steps: [
      {
        step: "navigate to the carrier page",
        navigateTo: `https://${OWN_BACKEND_HOST}/#/carrier/east-hub`,
        payloadField: "operator",
      },
    ],
    threaded: [{ field: "operator", kind: "carrier" }],
    gone: ["CX;filterType=carrier"],
    literal: ["SPRING;filterType=theme", "EXTRA;filterType=venue", "2027-03;filterType=date"],
  },
];

function buildCaptures(variant: Variant): Capture[] {
  return [
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/browse/`,
      requestPostData: JSON.stringify({
        ids: variant.browseIds ?? ["unrelated;filterId=urlFriendlyId"],
      }),
      responseBody: { ok: true },
      timestamp: "2026-01-01T00:00:00.000Z",
    }),
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/quote/`,
      requestPostData: JSON.stringify({ filters: variant.filters }),
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

function generate(variant: Variant): { contract: string; browserFlow: string } {
  workDir = mkdtempSync(join(tmpdir(), "barnacle-facet-array-variants-"));
  const runRoot = join(workDir, "run");
  writeRunDir(runRoot, buildCaptures(variant));

  const siteId = `facet-array-threading-variants-test-${process.pid}`;
  siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({
      steps: [...variant.steps, { step: "submit the quote", submitStep: true }],
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
  };
}

describe("recon-generate CLI — facet array threading holds across literals, kinds and order", () => {
  it.each(VARIANTS)(
    "$name",
    (variant) => {
      const { contract, browserFlow } = generate(variant);

      for (const { field, kind } of variant.threaded) {
        expect(contract, contract).toMatch(
          new RegExp(`payload\\.${field}[^\`]*;filterType=${kind}`)
        );
      }
      for (const gone of variant.gone) {
        expect(contract, contract).not.toContain(gone);
      }
      for (const literal of variant.literal) {
        expect(contract, contract).toContain(literal);
      }
      const positions = [
        ...variant.filters.map((element) => element.slice(element.indexOf(";"))),
      ].map((suffix) => contract.indexOf(suffix));
      expect(
        positions.every((at) => at >= 0),
        contract
      ).toBe(true);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
      expect(unreferencedDeclaredPayloadFields(contract, browserFlow, variant.steps)).toEqual([]);
    },
    30_000
  );
});
