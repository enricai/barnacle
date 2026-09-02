import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildWizardCheckoutCaptures } from "@/scripts/recon-generate-multicall-fixture";

/**
 * End-to-end coverage for docs/recon-emailed-verification-step-hook-for-
 * email-gated-account-flows.md's "shippable, not recon-only" requirement:
 * the generated plugin's mailbox source must be read from a payload/config
 * field, never a hardcoded testmail namespace/address. Drives the real
 * recon:generate CLI (mirroring recon-generate-submitstep-readonly-host-
 * provenance-e2e.test.ts's spawnSync harness) against a fixture run dir
 * whose flow.json step declares emailStep:true, then asserts on the
 * written flows/browser-flow.ts and contract.ts contents — a broader
 * end-to-end check than recon-generate-email-step-emission.test.ts's
 * narrower unit-level assertion on emitBrowserFlowTs's return value alone.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate emailStep mailbox provenance CLI e2e", () => {
  it("sources the generated plugin's mailbox from payload.Email, never a hardcoded testmail literal", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-recon-emailstep-mailbox-provenance-e2e-"));
    const runRoot = join(workDir, "run");
    const capturesDir = join(runRoot, "graphql");
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));

    // A real same-host multi-section submission sequence (wizard-checkout's
    // own precedent fixture) so isSubmissionFlow resolves true and both
    // contract.ts and flows/browser-flow.ts get written.
    const captures = buildWizardCheckoutCaptures();
    const filenames = captures.map(
      (_, index) => `${String(index).padStart(3, "0")}-checkout-action.json`
    );
    captures.forEach((capture, index) => {
      writeFileSync(join(capturesDir, filenames[index]!), JSON.stringify(capture));
    });

    const siteId = `recon-emailstep-mailbox-provenance-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "Fill in the Email field", payloadField: "Email" },
          {
            step: "Click the verification link sent to your email",
            emailStep: true,
            emailStepConfig: { subjectContains: "Verify your email", extract: "link" },
          },
          { step: "submit the application", submitStep: true },
        ],
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contractPath = join(siteOutDir, "contract.ts");
    const browserFlowPath = join(siteOutDir, "flows", "browser-flow.ts");
    expect(existsSync(contractPath)).toBe(true);
    expect(existsSync(browserFlowPath)).toBe(true);

    const contract = readFileSync(contractPath, "utf8");
    const browserFlow = readFileSync(browserFlowPath, "utf8");

    // The mailbox is resolved from payload.Email, and Email is a declared
    // field on contract.ts's payload schema — the field the browser flow
    // reads from actually exists on the public payload contract.
    expect(browserFlow).toContain(
      "const allocatedInbox = testmailInboxFromAddress(payload.Email);"
    );
    expect(contract).toMatch(/Email: z\.email\(\)/);

    // No hardcoded testmail namespace/address literal anywhere in the
    // generated flow — the inbox is derived from the caller-supplied
    // payload field, not a baked-in test address.
    expect(browserFlow).not.toMatch(/[\w.+-]+@[\w-]+\.testmail\.app/);
    expect(browserFlow).not.toMatch(/testmail\.app/);
  }, 30_000);
});
