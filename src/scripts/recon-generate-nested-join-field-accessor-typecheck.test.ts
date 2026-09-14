import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildMulticallSingleShotSearchDrillDownNestedJoinFieldActionSteps } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Regression for the report's secondary TS7053/TS18046-class defects: a
 * fold's join field lives under a NESTED path (`identifiers.sku`), and both
 * the loop item's own accessor (`scopedAccessor`/`joinAccessor`, spliced into
 * the re-issued drill request body) and the drill-down candidate's accessor
 * (`matchAccessorFor`, inside the `.find()` join comparison) chained the
 * second path segment as a plain dot/bracket access straight off a
 * `Record<string, unknown>`-typed runtime variable. The FIRST hop types as
 * `unknown` via the index signature, and TypeScript refuses any further
 * property/bracket access on `unknown` — surfacing as TS18046 at the access
 * itself and TS7053 at the following bracket hop.
 */
const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");
const OWN_BACKEND_HOST = "api.example.com";

function rehostCapture(capture: Capture): Capture {
  const rehostedUrl = new URL(capture.url);
  rehostedUrl.host = OWN_BACKEND_HOST;
  return { ...capture, url: rehostedUrl.toString() };
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

describe("recon-generate CLI + tsc --noEmit — nested-path fold accessor", () => {
  it("emits a contract.ts whose nested join-field accessors compile with zero diagnostics", () => {
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }

    workDir = mkdtempSync(join(tmpdir(), "barnacle-nested-join-accessor-"));
    const runRoot = join(workDir, "run");
    mkdirSync(join(runRoot, "graphql"), { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));

    const steps = buildMulticallSingleShotSearchDrillDownNestedJoinFieldActionSteps();
    const captures = steps.map((step) => rehostCapture(step.capture));
    captures.forEach((capture, index) => {
      writeFileSync(
        join(runRoot, "graphql", `${String(index).padStart(3, "0")}-capture.json`),
        JSON.stringify(capture)
      );
    });

    const siteId = `nested-join-accessor-test-p${process.pid}x`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "search for entries" }, { step: "get entry details" }],
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
    // Sanity: the fold-merge code this regression targets actually got
    // emitted (a nested join accessor with an intermediate cast), not some
    // unrelated branch that happens to also typecheck.
    expect(contract).toContain("as Record<string, unknown>).sku");

    tsconfigPath = join(REPO_ROOT, `tsconfig.nested-join-accessor.${process.pid}.json`);
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
