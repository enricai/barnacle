import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { RECON_GENERATE_CWD } from "@/scripts/recon-generate-cwd.test-helper";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.hash-facet-kind-suffixed-array-fixture.example.com";

const FILTERS = ["2026-12;filterType=date", "WW;filterType=warehouse"];

/**
 * Pins that hash-declared facets whose slugs (`west-hub`, `december-2026`)
 * appear only in a `;filterId=urlFriendlyId` body still rewrite their own
 * kind-suffixed `filters` elements, with the month translated to its code.
 */
function buildCaptures(): Capture[] {
  return [
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/browse/`,
      requestPostData: JSON.stringify({
        ids: ["west-hub;filterId=urlFriendlyId", "december-2026;filterId=urlFriendlyId"],
      }),
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

function generate(): { contract: string; browserFlow: string } {
  workDir = mkdtempSync(join(tmpdir(), "barnacle-hash-facet-array-"));
  const runRoot = join(workDir, "run");
  writeRunDir(runRoot, buildCaptures());

  const siteId = `hash-facet-kind-suffixed-array-test-${process.pid}`;
  siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({
      steps: [
        {
          step: "navigate to the warehouse page",
          navigateTo: `https://${OWN_BACKEND_HOST}/#/warehouse/west-hub`,
          payloadField: "warehouse",
        },
        {
          step: "navigate to the warehouse's month",
          navigateTo: `https://${OWN_BACKEND_HOST}/#/warehouse/west-hub/december-2026`,
          payloadField: "month",
        },
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
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return {
    contract: readFileSync(join(siteOutDir, "contract.ts"), "utf8"),
    browserFlow: readFileSync(join(siteOutDir, "flows", "browser-flow.ts"), "utf8"),
  };
}

describe("recon-generate CLI — hash facets whose slug never recurs thread into kind-suffixed array", () => {
  it("makes both elements payload-driven with no hardcoded literal left", () => {
    const { contract } = generate();

    expect(contract, contract).toMatch(/payload\.month[^`]*;filterType=date/);
    expect(contract, contract).toMatch(/payload\.warehouse[^`]*;filterType=warehouse/);
    expect(contract).not.toContain("2026-12;filterType=date");
    expect(contract).not.toContain("WW;filterType=warehouse");
  }, 30_000);

  it("translates the month slug into the element's code", () => {
    const { contract } = generate();
    const body = [...contract.matchAll(/body: (`.*`),\s*\n\s*schema:/g)]
      .map((match) => match[1] ?? "")
      .find((candidate) => candidate.includes("filterType=warehouse"));
    expect(body, contract).toBeDefined();
    const render = (payload: Record<string, string>): { filters: string[] } =>
      JSON.parse(new Function("payload", `return ${body}`)(payload));

    expect(render({ warehouse: "west-hub", month: "december-2026" }).filters).toEqual([
      "2026-12;filterType=date",
      "WW;filterType=warehouse",
    ]);
    expect(render({ warehouse: "XX", month: "2027-01" }).filters).toEqual([
      "2027-01;filterType=date",
      "XX;filterType=warehouse",
    ]);
  }, 30_000);
});
