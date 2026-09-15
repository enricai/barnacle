import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { emitMultiStepExecuteHttp } from "@/scripts/recon-generate";
import {
  buildMulticallHeterogeneousActionStepsWithBookingSubmit,
  buildMulticallSingleShotSearchDrillDownNestedJoinFieldActionSteps,
} from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Regression for the report's secondary TS7053/TS18046/TS2740-class defects:
 * `emitFoldMatchAndMergeLines`'s `Object.assign(itemVar,
 * Object.fromEntries(Object.entries(foldMatch ?? {}).filter(...)))` merge
 * object, together with a fold chain's final response getting cast back to
 * the plugin's own inferred response schema, must both compile clean on a
 * regenerated `contract.ts` — not merely on a hand-picked fixture.
 */
const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

function rehostCapture(capture: Capture, host: string): Capture {
  const rehostedUrl = new URL(capture.url);
  rehostedUrl.host = host;
  return { ...capture, url: rehostedUrl.toString() };
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

function typecheckSite(siteId: string, tsconfigPath: string): string {
  writeFileSync(
    tsconfigPath,
    JSON.stringify({
      extends: "./tsconfig.json",
      compilerOptions: {
        noEmit: true,
        incremental: false,
        tsBuildInfoFile: null,
        paths: {
          "@/*": ["./src/*"],
          "@test/*": ["./test/*"],
          "@enricai/barnacle/*": ["./src/*"],
        },
      },
      include: [`src/sites/${siteId}/**/*.ts`],
    })
  );
  const check = spawnSync(TSC_BIN, ["-p", tsconfigPath, "--noEmit"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  const diagnostics = `${check.stdout}\n${check.stderr}`;
  expect(check.status, diagnostics).toBe(0);
  return diagnostics;
}

let workDir: string | null = null;
let siteOutDir: string | null = null;
let tsconfigPath: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  if (tsconfigPath) rmSync(tsconfigPath, { force: true });
  workDir = null;
  siteOutDir = null;
  tsconfigPath = null;
});

describe("emitFoldMatchAndMergeLines merge object + response-schema cast — typecheck regression", () => {
  it("emits a fold-match merge whose nested join accessors typecheck with zero diagnostics", () => {
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }

    workDir = mkdtempSync(join(tmpdir(), "barnacle-foldmatch-merge-typing-"));
    const runRoot = join(workDir, "run");
    const host = "www.foldmatch-merge-typing-fixture.example.com";
    const captures = buildMulticallSingleShotSearchDrillDownNestedJoinFieldActionSteps().map(
      (step) => rehostCapture(step.capture, host)
    );
    writeRunDir(runRoot, captures);

    const siteId = `foldmatch-merge-typing-test-p${process.pid}x`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "search for entries" }, { step: "get entry details" }],
        ownBackendHostnames: [host],
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    // Confirms the merge object this regression targets was actually
    // emitted, not some unrelated branch that happens to also typecheck.
    expect(contract).toContain("Object.fromEntries(Object.entries(foldMatch");
    expect(contract).toContain("as Record<string, unknown>).sku");

    tsconfigPath = join(REPO_ROOT, `tsconfig.foldmatch-merge-typing.${process.pid}.json`);
    typecheckSite(siteId, tsconfigPath);
  }, 60_000);

  it("casts a fold+drill+submit chain's final response back to the plugin's own response type with zero diagnostics", () => {
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }

    // Unit-level: the emitted merge body always assigns THROUGH
    // Object.fromEntries against the untyped `Record<string, unknown>`
    // capture, never a bare property spread that would keep an implicit any.
    const steps = buildMulticallHeterogeneousActionStepsWithBookingSubmit().slice(0, 4);
    const body = emitMultiStepExecuteHttp(
      steps,
      null,
      { stringMessageKey: null, nestedErrorPaths: [] },
      new Map(),
      new Set(),
      new Map(),
      new Set(),
      new Map(),
      new Map(),
      "https://api.example.com",
      new Map(),
      new Map(),
      null,
      new Map(),
      new Map(),
      new Set(),
      [],
      new Map(),
      new Map(),
      null,
      "FoldMatchMergeTypingFixture"
    );
    expect(body).toContain("as unknown as FoldMatchMergeTypingFixtureResponse };");

    workDir = mkdtempSync(join(tmpdir(), "barnacle-foldmatch-response-cast-typing-"));
    const runRoot = join(workDir, "run");
    const host = "www.foldmatch-response-cast-typing-fixture.example.com";
    const captures = buildMulticallHeterogeneousActionStepsWithBookingSubmit().map((step) =>
      rehostCapture(step.capture, host)
    );
    writeRunDir(runRoot, captures);

    const siteId = `foldmatch-response-cast-typing-test-p${process.pid}x`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "authorize session" },
          { step: "browse paged facet search" },
          { step: "drill into unit availability" },
          { step: "book availability", submitStep: true },
        ],
        ownBackendHostnames: [host],
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contract).toContain("as unknown as");

    tsconfigPath = join(REPO_ROOT, `tsconfig.foldmatch-response-cast-typing.${process.pid}.json`);
    typecheckSite(siteId, tsconfigPath);
  }, 60_000);
});
