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

const OWN_BACKEND_HOST = "www.hash-and-click-facet-threading-fixture.example.com";

const FILTERS = [
  "WW;filterType=ship",
  "2026-12;filterType=date",
  "PARIS;filterType=destination",
  "BETA;filterType=theme",
  "GAMMA;filterType=island",
];

const DESTINATION_STEP =
  "Open the destination filter dropdown in the search bar and select the 'Paris' destination option, keeping the other filters that are already applied";
const NIGHTS_STEP =
  "Open the length of stay (number of nights) filter dropdown in the search bar and select the '4' nights option, keeping the other filters that are already applied";

/**
 * Pins that hash-slug facets (`disney-wish`, `december-2026`) and click-step
 * facets all rewrite their own kind-suffixed `filters` elements, that kinds no
 * payloadField declares stay literal, and that a declared facet no request
 * carries is emitted optional instead of a required field nothing reads.
 */
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
      requestPostData: JSON.stringify({ filters: FILTERS }),
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

const DECLARED_STEPS = [
  { step: "navigate", payloadField: "ship" },
  { step: "navigate", payloadField: "sailMonth" },
  { step: DESTINATION_STEP, payloadField: "destination" },
  { step: NIGHTS_STEP, payloadField: "nights" },
];

function generate(): { contract: string; browserFlow: string } {
  workDir = mkdtempSync(join(tmpdir(), "barnacle-hash-and-click-facet-"));
  const runRoot = join(workDir, "run");
  writeRunDir(runRoot, buildCaptures());

  const siteId = `hash-and-click-facet-threading-test-${process.pid}`;
  siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({
      steps: [
        {
          step: "navigate to the ship page",
          navigateTo: `https://${OWN_BACKEND_HOST}/#/ship/disney-wish`,
          payloadField: "ship",
        },
        {
          step: "navigate to the ship's sailing month",
          navigateTo: `https://${OWN_BACKEND_HOST}/#/ship/disney-wish/december-2026`,
          payloadField: "sailMonth",
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
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return {
    contract: readFileSync(join(siteOutDir, "contract.ts"), "utf8"),
    browserFlow: readFileSync(join(siteOutDir, "flows", "browser-flow.ts"), "utf8"),
  };
}

describe("recon-generate CLI — hash and click facets threaded into a filters array", () => {
  it("threads ship, sailMonth and destination into their elements and leaves undeclared kinds literal", () => {
    const { contract } = generate();

    expect(contract, contract).toMatch(/payload\.ship[^`]*;filterType=ship/);
    expect(contract, contract).toMatch(/payload\.sailMonth[^`]*;filterType=date/);
    expect(contract, contract).toMatch(/payload\.destination[^`]*;filterType=destination/);
    for (const replaced of ["WW;filterType=ship", "2026-12;filterType=date", "PARIS;filterType"]) {
      expect(contract).not.toContain(replaced);
    }
    expect(contract).toContain('"BETA;filterType=theme"');
    expect(contract).toContain('"GAMMA;filterType=island"');
  }, 30_000);

  it("emits a filters body that evaluates as plain JavaScript in whichever vocabulary the caller supplies", () => {
    const { contract } = generate();
    const body = [...contract.matchAll(/body: (`.*`),\s*\n\s*schema:/g)]
      .map((match) => match[1] ?? "")
      .find((candidate) => candidate.includes("filterType=ship"));
    expect(body, contract).toBeDefined();
    const render = (payload: Record<string, string>): { filters: string[] } =>
      JSON.parse(new Function("payload", `return ${body}`)(payload));

    const declared = { ship: "disney-wish", sailMonth: "december-2026", destination: "Rome" };
    expect(render(declared).filters).toEqual([
      "WW;filterType=ship",
      "2026-12;filterType=date",
      "ROME;filterType=destination",
      "BETA;filterType=theme",
      "GAMMA;filterType=island",
    ]);
    const coded = { ship: "XX", sailMonth: "2027-01", destination: "Oslo" };
    expect(render(coded).filters.slice(0, 3)).toEqual([
      "XX;filterType=ship",
      "2027-01;filterType=date",
      "OSLO;filterType=destination",
    ]);
  }, 30_000);

  it("emits the facet no request carries as optional and keeps the browser flow reading it", () => {
    const { contract, browserFlow } = generate();

    expect(contract).toMatch(/nights: z\.string\(\)\.optional\(\)/);
    expect(browserFlow).toContain('payload.nights ?? "4"');
    expect(unreferencedDeclaredPayloadFields(contract, browserFlow, DECLARED_STEPS)).toEqual([]);
  }, 30_000);
});
