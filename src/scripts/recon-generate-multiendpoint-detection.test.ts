import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildMultiEndpointSubmissionActionSteps } from "@/scripts/recon-generate-multiendpoint-fixture";

/**
 * Pins the defect class bugfix-002 fixes for the case where a submission
 * spans several DISTINCT endpoint paths (not one endpoint overloaded by
 * body, already covered by recon-generate.test.ts:447-501's "isolates the
 * submission from same-URL chrome" suite). recon-browser's submit-manifest.json
 * (recon-browser.ts:457-502) narrows the submission to whatever single call
 * matched the flow's declared submit step, discarding the other genuine
 * section-save POSTs it also captured. Before the fix, recon-generate.ts's
 * main() trusted that narrow manifest unconditionally; after the fix it is
 * only trusted when it isn't a strict undercount of the same captures' own
 * heuristic action-sequence extraction (recon-generate.ts, resolveManifestActionSequence
 * vs extractActionSequence precedence around recon-generate.ts:4770-4800).
 *
 * Exercises the real CLI (matches recon-generate-manifest-undercoverage.test.ts's
 * spawnSync harness), since the precedence decision lives only inside
 * main() and is not itself an exported, independently callable function.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

let workDir: string | null = null;
let siteOutDir: string | null = null;
let flowFile: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  if (flowFile) rmSync(flowFile, { force: true });
  workDir = null;
  siteOutDir = null;
  flowFile = null;
});

describe("recon-generate: a submission spanning distinct endpoint paths must not collapse to one matched call", () => {
  it("keeps every section POST and validate PUT from the multi-endpoint fixture", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-recon-multiendpoint-detection-"));
    const runRoot = join(workDir, "run");
    const capturesDir = join(runRoot, "graphql");
    const replaysDir = join(runRoot, "replays");
    const auxDir = join(runRoot, "aux");
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(replaysDir, { recursive: true });
    mkdirSync(auxDir, { recursive: true });
    writeFileSync(join(replaysDir, "rate-limit.json"), JSON.stringify([]));

    const steps = buildMultiEndpointSubmissionActionSteps();
    const captures = steps.map((step) => step.capture);
    captures.forEach((capture, index) => {
      const filename = `${String(index).padStart(3, "0")}-application-action.json`;
      writeFileSync(join(capturesDir, filename), JSON.stringify(capture));
    });

    // Under-covering submit-manifest.json: recon-browser matched only the
    // final PUT validate against the flow's declared submit step, so it
    // authoritatively narrates the whole application as that one capture —
    // even though 7 other genuine section-save calls were captured, each
    // hitting a distinct endpoint path (not one endpoint overloaded by body).
    const submitIndex = captures.length - 1;
    const submitCapture = captures[submitIndex];
    if (!submitCapture) throw new Error("unreachable");
    writeFileSync(
      join(runRoot, "submit-manifest.json"),
      JSON.stringify([
        {
          index: submitIndex,
          filename: `${String(submitIndex).padStart(3, "0")}-application-action.json`,
          url: submitCapture.url,
        },
      ])
    );

    const siteId = `recon-multiendpoint-detection-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    flowFile = join(siteOutDir, "recon-flow.json");
    writeFileSync(
      flowFile,
      JSON.stringify({
        steps: [
          {
            step: "fill out the applicant, address, contact, employment, and attachments sections",
          },
          { step: "submit the application for validation", submitStep: true },
        ],
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // What SHOULD happen: the full 8-call sequence that was actually
    // captured drives executeHttp, not a fabricated single-call {query}
    // stub built from only the manifest's one matched validate PUT.
    expect(contract).not.toContain("query: z.string().min(1)");
    expect(contract).not.toContain("payload.query");
    expect(contract).toContain("/applications");
    expect(contract).toContain("/applicant");
    expect(contract).toContain("/address");
    expect(contract).toContain("/contact");
    expect(contract).toContain("/employment");
    expect(contract).toContain("/attachments");
    expect(contract).toContain("/validate");
  }, 30_000);
});
