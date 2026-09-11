import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildManyRepeatPagedListingDrillWithNoiseVariantActionSteps } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Reproduces the report's problem #1 (every repeated same-endpoint capture
 * unrolled as its own hard-coded `httpClient` call instead of collapsing
 * into a paged loop + a hoisted per-item drill) against the SAME many-repeat
 * capture set run through two structurally different flow.json shapes — a
 * short linear flow and a longer facet-capturing flow — proving the
 * collapse is a property of the capture set, not of one particular flow
 * declaration.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "api.example.com";
const PAGE_COUNT = 9;
const DRILL_COUNT = 7;

function manyRepeatCaptures(): Capture[] {
  return buildManyRepeatPagedListingDrillWithNoiseVariantActionSteps(PAGE_COUNT, DRILL_COUNT).map(
    (step) => step.capture
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

const FLOW_CASES = [
  {
    label: "short linear flow",
    flow: {
      steps: [
        { step: "browse paged listing" },
        { step: "drill into item detail", submitStep: true },
      ],
      submitEndpointPattern: "available-units",
      requireSubmitEndpointMatch: true,
      ownBackendHostnames: [OWN_BACKEND_HOST],
    },
  },
  {
    label: "longer facet-capturing flow",
    flow: {
      steps: [
        { step: "open listing landing page" },
        { step: "apply category facet" },
        { step: "apply region facet" },
        { step: "browse paged listing" },
        { step: "sort listing results" },
        { step: "drill into item detail", submitStep: true },
      ],
      submitEndpointPattern: "available-units",
      requireSubmitEndpointMatch: true,
      ownBackendHostnames: [OWN_BACKEND_HOST],
    },
  },
];

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate CLI — many-repeat paged-listing + drill collapse holds across differently-shaped flows", () => {
  it.each(FLOW_CASES)(
    "emits a call count bounded independent of repeat count for $label",
    ({ flow }) => {
      workDir = mkdtempSync(join(tmpdir(), "barnacle-submission-sequence-collapse-scale-e2e-"));
      const runRoot = join(workDir, "run");
      writeRunDir(runRoot, manyRepeatCaptures());

      const siteId = `submission-sequence-collapse-scale-e2e-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
      siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
      mkdirSync(siteOutDir, { recursive: true });
      writeFileSync(join(siteOutDir, "recon-flow.json"), JSON.stringify(flow));

      const result = spawnSync(
        TSX_BIN,
        [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
        { cwd: REPO_ROOT, encoding: "utf8" }
      );

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

      const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
      const httpClientCallCount = (contract.match(/await httpClient\(/g) ?? []).length;

      // Raw capture count is PAGE_COUNT + DRILL_COUNT + 1 noise = 17. Before
      // the fix this scaled 1:1 with the repeat count; the fix collapses the
      // paged listing into one loop and the per-item drill into one hoisted
      // call, so the bound stays small and independent of PAGE_COUNT/DRILL_COUNT.
      expect(httpClientCallCount).toBeLessThanOrEqual(10);
    },
    30_000
  );
});
