import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildMultiEndpointSubmissionActionSteps } from "@/scripts/recon-generate-multiendpoint-fixture";

/**
 * Full-pipeline no-regression proof for "Never freeze a captured Cookie
 * header into per-call request headers" (see
 * recon-generate-percall-cookie-header-never-frozen.test.ts): a Set-Cookie
 * response minting a session token on the first call of a genuine
 * multi-endpoint submission sequence, replayed on a later call's `Cookie`
 * request header alongside unrelated stale jar values (the exact mixed
 * shape the fix targets), must still reach the emitted `contract.ts` via the
 * `bind` option — only the unbound jar values must be dropped. A fix that
 * blanket-strips every Cookie header instead of skipping the per-call
 * literal-freeze loops would pass the sibling frozen-jar test but silently
 * break this. Reuses buildMultiEndpointSubmissionActionSteps (already proven
 * through the real CLI by recon-generate-multiendpoint-e2e.test.ts) instead
 * of inventing a new fixture shape, per the investigation notes.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");
const MINTED_TOKEN = "MINTED_SESSION_TOKEN_7788AA";

/** Unrelated stale jar values never produced by any prior step — the shape
 * the per-call-freeze fix must still strip. */
function staleJarFragment(): string {
  return [
    "sessionId=sess-9f8e7d6c5b4a3210",
    "AMCV_ADOBEORG=1234567890%7CMCIDTS%7C19999",
    "ak_bmsc=AK_BMSC_LONG_OPAQUE_VALUE_1234567890ABCDEF",
  ].join("; ");
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate CLI — a genuine Set-Cookie-bound cookie survives the per-call freeze fix", () => {
  it("emits a bind entry forwarding the minted cookie while dropping the unrelated stale jar values", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-cookie-binding-survival-e2e-"));
    const runRoot = join(workDir, "run");
    const capturesDir = join(runRoot, "graphql");
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));

    const steps = buildMultiEndpointSubmissionActionSteps();

    // First call mints a session token via Set-Cookie.
    steps[0]!.capture.responseHeaders = {
      ...steps[0]!.capture.responseHeaders,
      "set-cookie": `authToken=${MINTED_TOKEN}; Path=/; HttpOnly`,
    };
    // A later call replays the minted token mixed with unrelated stale jar
    // values — the exact mixed-cookie-header shape the reported finding covers.
    steps[2]!.capture.requestHeaders = {
      ...steps[2]!.capture.requestHeaders,
      Cookie: `authToken=${MINTED_TOKEN}; ${staleJarFragment()}`,
    };

    steps.forEach((step, index) => {
      const filename = `${String(index).padStart(3, "0")}-multiendpoint-action.json`;
      writeFileSync(join(capturesDir, filename), JSON.stringify(step.capture));
    });

    const siteId = `cookie-binding-survival-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "fill out applicant, address, contact, employment, and attachment sections" },
          { step: "submit address section", submitStep: true },
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

    // The Set-Cookie-origin bind mechanism still threads the minted cookie.
    expect(contract).toContain("createHttpClient(");
    expect(contract).toMatch(/bind:\s*\[\{[^}]*sourceHeader:\s*"set-cookie"/);
    expect(contract).toContain('cookieName: "authToken"');
    expect(contract).toContain('targetHeader: "Cookie"');

    // The unrelated stale jar values are never frozen in as literals, nor is
    // the minted value itself frozen in as a literal (it must thread only
    // through the bind mechanism above).
    expect(contract).not.toContain("sessionId=sess-9f8e7d6c5b4a3210");
    expect(contract).not.toContain("AMCV_ADOBEORG");
    expect(contract).not.toContain("ak_bmsc");
    expect(contract).not.toContain(MINTED_TOKEN);
  }, 30_000);
});
