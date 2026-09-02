import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Guards the "zero-cost when absent" guarantee the doc claims for emailStep,
 * mirroring the same promise `captchaGated` already makes: a flow that
 * declares no emailStep-flagged steps must emit byte-identical
 * flows/browser-flow.ts and contract.ts whether or not the emitter knows how
 * to handle emailStep. Runs the real `recon:generate` CLI end to end rather
 * than calling emitBrowserFlowTs directly, so it also covers emitContractTs
 * and the file-write path.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

function capture(): unknown {
  return {
    timestamp: "2024-01-01T00:00:00Z",
    phase: "action",
    method: "POST",
    url: "https://api.example.com/submit",
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ name: "Jane Doe" }),
    responseHeaders: { "content-type": "application/json" },
    responseBody: { success: true },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate CLI — no-emailStep flows are unaffected by emailStep emission", () => {
  it("emits flows/browser-flow.ts and contract.ts with no emailStep/emailStepConfig keys or mailbox plumbing", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-no-emailstep-"));
    const runRoot = join(workDir, "run");
    mkdirSync(join(runRoot, "graphql"), { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
    writeFileSync(join(runRoot, "graphql", "000-action-action.json"), JSON.stringify(capture()));

    const siteId = `no-emailstep-regression-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "Fill in the application form" },
          { step: "Click the Submit button", submitStep: true },
        ],
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const browserFlow = readFileSync(join(siteOutDir, "flows", "browser-flow.ts"), "utf8");
    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    for (const source of [browserFlow, contract]) {
      expect(source).not.toContain("emailStep");
      expect(source).not.toContain("emailStepConfig");
      expect(source).not.toContain("testmailInboxFromAddress");
      expect(source).not.toContain("allocatedInbox");
    }
  }, 30_000);
});
