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

const OWN_BACKEND_HOST = "www.gear-shop-declared-facet-fixture.example.com";

const SHADE_STEP =
  "Open the colour filter dropdown in the sidebar and select the 'Red' colour option, keeping the other filters that are already applied";
const SIZE_STEP =
  "Open the size filter dropdown in the sidebar and select the 'Large' size option, keeping the other filters that are already applied";
const WARRANTY_STEP =
  "Open the warranty length filter dropdown in the sidebar and select the '24' months option, keeping the other filters that are already applied";

const SIDEBAR_ELEMENTS = [
  "2026-12;filterType=release",
  "GADGETS;filterType=category",
  "RED;filterType=color",
  "LG;filterType=size",
  "4;filterType=pack",
  "EU;filterType=market",
];

const FLOW_STEPS = [
  {
    step: "navigate to the gadgets category page",
    navigateTo: `https://${OWN_BACKEND_HOST}/#/browse/gadgets`,
    payloadField: "category",
  },
  { step: SHADE_STEP, payloadField: "shade" },
  { step: SIZE_STEP, payloadField: "sizeClass" },
  { step: WARRANTY_STEP, payloadField: "warranty" },
  { step: "submit the order", submitStep: true },
];

/**
 * Mixed capture set: hash-style bodies (`<slug>;filterId=urlFriendlyId`) plus
 * one body whose filters array is entirely `<CODE>;filterType=<kind>`. Each
 * declared click facet names a field that differs from its element kind.
 */
function buildCaptures(): Capture[] {
  const bodies: Array<[string, unknown]> = [
    ["/browse/", { filters: ["gadgets;filterId=urlFriendlyId", "red;filterId=urlFriendlyId"] }],
    ["/sidebar/", { filters: SIDEBAR_ELEMENTS }],
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
  workDir = mkdtempSync(join(tmpdir(), "barnacle-declared-facet-kind-suffixed-"));
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

  const siteId = `declared-facet-kind-suffixed-test-${process.pid}`;
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
  return {
    contract: readFileSync(join(siteOutDir, "contract.ts"), "utf8"),
    browserFlow: readFileSync(join(siteOutDir, "flows", "browser-flow.ts"), "utf8"),
    output,
  };
}

describe("recon-generate CLI — declared click facets threaded into a kind-suffixed array", () => {
  it("threads every observed facet through a conditional spread keyed by its declared field", () => {
    const { contract } = generate();

    expect(contract, contract).toMatch(/payload\.shade[^\x60]*;filterType=color/);
    expect(contract, contract).toMatch(/payload\.sizeClass[^\x60]*;filterType=size/);
    expect(contract, contract).toMatch(/payload\.category[^\x60]*;filterType=category/);
    expect(contract, contract).not.toContain("RED;filterType=color");
    expect(contract, contract).not.toContain("LG;filterType=size");
  }, 60_000);

  it("translates the caller's value to the captured code", () => {
    const { contract } = generate();

    expect(contract, contract).toMatch(/Red[^\n]*RED|RED[^\n]*Red/i);
    expect(contract, contract).toMatch(/Large[^\n]*LG|LG[^\n]*Large/i);
  }, 60_000);

  it("never leaves a required declared field unread without a warning", () => {
    const { contract, browserFlow, output } = generate();
    const declared = FLOW_STEPS.filter((s) => s.payloadField).map((s) => ({
      step: s.step,
      payloadField: s.payloadField as string,
    }));
    const unread = unreferencedDeclaredPayloadFields(contract, browserFlow, declared);

    for (const field of unread) {
      expect(output, output).toContain(`declared payloadField ${field} is read by no emitted request`);
      expect(contract, contract).toMatch(new RegExp(`${field}: z\\.string\\(\\)\\.optional\\(\\)`));
    }
    expect(unread).not.toContain("shade");
    expect(unread).not.toContain("sizeClass");
  }, 60_000);
});
