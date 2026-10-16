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

const OWN_BACKEND_HOST = "www.kind-keyed-array-other-endpoint-fixture.example.com";

const CITY_STEP =
  "Open the destination dropdown in the catalogue toolbar and select the 'Lisbon' city option";
const STAY_STEP =
  "Open the stay length dropdown in the catalogue toolbar and select the '3' nights option";

/**
 * Pins that a kind-keyed array on an endpoint other than the one carrying the
 * declared literal's slug is owned by the same resolved facet set: its
 * elements are threaded from payload fields, including an element of a kind
 * that is absent from some captures.
 */
function buildCaptures(): Capture[] {
  return [
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/browse/`,
      requestPostData: JSON.stringify({ filters: ["lisbon;filterId=urlFriendlyId"] }),
      responseBody: { ok: true },
      timestamp: "2026-01-01T00:00:00.000Z",
    }),
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/quote/`,
      requestPostData: JSON.stringify({
        filters: ["LIS;filterType=city", "N3;filterType=nights"],
      }),
      responseBody: { ok: true },
      timestamp: "2026-01-01T00:00:01.000Z",
    }),
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/quote/`,
      requestPostData: JSON.stringify({ filters: ["LIS;filterType=city"] }),
      responseBody: { ok: true },
      timestamp: "2026-01-01T00:00:02.000Z",
    }),
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/submit/`,
      requestPostData: JSON.stringify({ confirm: true }),
      responseBody: { ok: true },
      timestamp: "2026-01-01T00:00:03.000Z",
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
  { step: "navigate", payloadField: "city" },
  { step: STAY_STEP, payloadField: "nights" },
];

function generate(): string {
  workDir = mkdtempSync(join(tmpdir(), "barnacle-kind-keyed-array-"));
  const runRoot = join(workDir, "run");
  writeRunDir(runRoot, buildCaptures());

  const siteId = `kind-keyed-array-other-endpoint-test-${process.pid}`;
  siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({
      steps: [
        {
          step: "navigate to the catalogue for a city",
          navigateTo: `https://${OWN_BACKEND_HOST}/#/catalogue/lisbon`,
          payloadField: "city",
        },
        { step: STAY_STEP, payloadField: "nights" },
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
  return readFileSync(join(siteOutDir, "contract.ts"), "utf8");
}

describe("recon-generate CLI — kind-keyed array on a different endpoint", () => {
  it("threads every declared field and leaves no hardcoded kind-keyed element", () => {
    const contract = generate();

    expect(contract, contract).toMatch(/payload\.city/);
    expect(contract, contract).toMatch(/payload\.nights[^`]*;filterType=nights/);
    expect(contract, contract).not.toContain("LIS;filterType=city");
    expect(contract, contract).not.toContain("N3;filterType=nights");
    expect(unreferencedDeclaredPayloadFields(contract, "", DECLARED_STEPS)).toEqual([]);
  }, 30_000);
});
