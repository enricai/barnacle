import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { emitMultiStepExecuteHttp } from "@/scripts/recon-generate";
import { buildMulticallHeterogeneousActionStepsWithBookingSubmit } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Regression for the report's secondary TS2740-class defect: every
 * `httpClient` call `emitMultiStepExecuteHttp` emits is bound `as Record<string,
 * unknown>` so per-item fold/merge code can probe arbitrary fields, but that
 * widened intermediate type doesn't structurally satisfy the richer
 * `${pascal}Response` the plugin's own `execute()` return type promises —
 * `return { data: r2 }` failed to typecheck ("Type 'Record<string, unknown>'
 * is missing the following properties...") even though the fold/merge logic
 * itself was correct.
 */
const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");
const OWN_BACKEND_HOST = "www.own-backend-fold-return-cast-fixture.example.com";

function rehostCapture(capture: Capture): Capture {
  const rehostedUrl = new URL(capture.url);
  rehostedUrl.host = OWN_BACKEND_HOST;
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

describe("emitMultiStepExecuteHttp — final return cast back to the promised response type", () => {
  it("passes a pascalName param through to the final return statement's cast", () => {
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
      "MyPlugin"
    );

    expect(body).toContain("as unknown as MyPluginResponse };");
  });

  it("omits the cast when no pascalName is given (test-facing default), preserving prior output", () => {
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
      new Map()
    );

    expect(body).not.toContain("as unknown as");
  });

  it("compiles the real CLI-emitted fold+drill+submit flow with zero tsc diagnostics", () => {
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }

    workDir = mkdtempSync(join(tmpdir(), "barnacle-fold-return-cast-"));
    const runRoot = join(workDir, "run");
    const captures = buildMulticallHeterogeneousActionStepsWithBookingSubmit().map((step) =>
      rehostCapture(step.capture)
    );
    writeRunDir(runRoot, captures);

    const siteId = `fold-return-cast-test-p${process.pid}x`;
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
        ownBackendHostnames: [OWN_BACKEND_HOST],
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

    tsconfigPath = join(REPO_ROOT, `tsconfig.fold-return-cast.${process.pid}.json`);
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
  }, 60_000);
});
