import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildWizardCheckoutCaptures } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Integration checkpoint for the four splice/schema defects the recon report
 * flagged: drives the real CLI against a synthetic cross-domain submission
 * flow whose steps reproduce every reported grammar shape at once (a
 * selector-qualified fill, RECON_EMAIL, RECON_PHONE, RECON_PASSWORD, and an
 * upload step), then type-checks the emitted contract.ts + browser-flow.ts
 * with the project's own `tsc --noEmit`. Defect 1 (the chained `.extend()`
 * overload) alone makes the emitted contract fail TS2769, so this test is
 * unwritable/failing until all four fixes land together.
 */
const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

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

/**
 * A minimal `--vocabulary` module so the flow's label-derived steps (First
 * Name, Email, Phone) actually resolve to payload fields instead of staying
 * inert under the CLI's default EMPTY_VOCABULARY — without this, Defects 1
 * and 4 (the chained/duplicated `.extend()` schema) never engage, since no
 * field ever gets spliced. "Phone" deliberately collides with a name
 * ApplicantContactSchema's own identity/address merge already declares, so
 * the reserved-name guard (Defect 1's fix) is exercised too.
 */
function writeVocabularyModule(workDir: string): string {
  const vocabPath = join(workDir, "vocabulary.mjs");
  writeFileSync(
    vocabPath,
    `export const vocabulary = {
  subject: /(?!)/,
  exclusions: [],
  table: [
    [/first name/i, "FirstName"],
    [/\\bemail\\b/i, "Email"],
    [/\\bphone\\b/i, "Phone"],
  ],
};
`
  );
  return vocabPath;
}

describe("recon-generate CLI + tsc --noEmit — the four splice/schema defects closed together", () => {
  it("emits a contract.ts and browser-flow.ts that compile with zero diagnostics", () => {
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }

    workDir = mkdtempSync(join(tmpdir(), "barnacle-recon-tsc-clean-emit-"));
    const runRoot = join(workDir, "run");
    const capturesDir = join(runRoot, "graphql");
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));

    // A same-host multi-section submission sequence, with the terminal call
    // redirected to a second host — the browserFlowOnly / isSubmissionFlow
    // shape the report's own scenario takes (recon-generate-browser-flow-
    // only.test.ts's own precedent for this cross-host construction).
    const captures = buildWizardCheckoutCaptures();
    const last = captures[captures.length - 1]!;
    captures[captures.length - 1] = {
      ...last,
      url: last.url.replace("https://api.example.com", "https://payments.example.net"),
    };
    const filenames = captures.map(
      (_, index) => `${String(index).padStart(3, "0")}-checkout-action.json`
    );
    captures.forEach((capture, index) => {
      writeFileSync(join(capturesDir, filenames[index]!), JSON.stringify(capture));
    });

    // extractActionSequence drops any capture off the run's baseUrl host
    // outright — submit-manifest.json is the one path that carries the
    // cross-host entry through to compileActionSteps.
    writeFileSync(
      join(runRoot, "submit-manifest.json"),
      JSON.stringify(
        captures.map((capture, index) => ({ index, filename: filenames[index]!, url: capture.url }))
      )
    );

    const siteId = `recon-tsc-clean-emit-e2e-test${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });

    // The exact reported grammar shapes: a quoted selector preceding a
    // quoted fill value, a RECON_EMAIL token, a RECON_PHONE token, a
    // RECON_PASSWORD token, and a multipart upload step.
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          {
            step: "Fill in the Legal Name First Name field (data-automation-id='legalName--firstName') with 'Reginald'",
          },
          { step: `Fill in the Email field with '$${"{RECON_EMAIL}"}'` },
          { step: `Fill in the Phone field with '$${"{RECON_PHONE}"}'` },
          { step: `Fill in the Password field with '$${"{RECON_PASSWORD}"}'` },
          { step: "Upload the resume file", upload: true },
          { step: "submit the application", submitStep: true },
        ],
      })
    );

    const vocabularyPath = writeVocabularyModule(workDir);

    const result = spawnSync(
      TSX_BIN,
      [
        GENERATE_SCRIPT,
        "--site-id",
        siteId,
        "--run-dir",
        runRoot,
        "--emit",
        "ts",
        "--force",
        "--vocabulary",
        vocabularyPath,
      ],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contractPath = join(siteOutDir, "contract.ts");
    const browserFlowPath = join(siteOutDir, "flows", "browser-flow.ts");
    expect(existsSync(contractPath)).toBe(true);
    expect(existsSync(browserFlowPath)).toBe(true);

    // Defect 1/4's regression guard: every field source (base extend, the
    // browser-flow-spliced FirstName/Email, and the RECON_PASSWORD-reserved
    // throwaway) collapses into a SINGLE `.extend({...})` call, and "Phone"
    // — a name ApplicantContactSchema's own identity merge already declares
    // — is never redeclared.
    const contract = readFileSync(contractPath, "utf8");
    const payloadSchemaMatch = /const \w+PayloadSchema = [\s\S]*?;\n/.exec(contract);
    expect(payloadSchemaMatch).not.toBeNull();
    const payloadSchemaSource = payloadSchemaMatch![0];
    const extendOccurrences = payloadSchemaSource.match(/\.extend\(/g) ?? [];
    expect(extendOccurrences.length).toBe(1);
    expect(payloadSchemaSource).not.toMatch(/^\s*Phone:/m);
    const emailOccurrences = payloadSchemaSource.match(/^\s*Email:/gm) ?? [];
    expect(emailOccurrences.length).toBe(1);

    // Uniquely named and removed in `finally` (well, `afterEach`) so it never
    // collides with the real tsconfig, matching recon-generate.build.test.ts's
    // own throwaway-tsconfig pattern. Emitted plugins import their engine
    // dependencies through the bare `@enricai/barnacle/*` specifier (the
    // out-of-tree operator's own installed package) — this repo IS that
    // package, and its subpaths mirror `src/*` 1:1, so a `paths` override
    // resolves the emitted imports against source without a dist build.
    tsconfigPath = join(REPO_ROOT, `tsconfig.recon-tsc-clean-emit.${process.pid}.json`);
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
    const referencesEmittedFiles =
      diagnostics.includes("contract.ts") || diagnostics.includes("browser-flow.ts");
    expect(referencesEmittedFiles, diagnostics).toBe(false);
    expect(check.status, diagnostics).toBe(0);
  }, 60_000);
});
