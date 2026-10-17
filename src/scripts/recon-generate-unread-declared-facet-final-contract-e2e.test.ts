import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { unreferencedDeclaredPayloadFields } from "@/scripts/recon-generate";
import { RECON_GENERATE_CWD } from "@/scripts/recon-generate-cwd.test-helper";
import { buildMultiEndpointSubmissionActionSteps } from "@/scripts/recon-generate-multiendpoint-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * A declared payloadField that governs no emitted request must stay optional and
 * warned about in the FINAL contract when an unrelated *Url-bearing noise
 * capture shares the pool. The fixture does not currently trip
 * healUnreferencedUrlFieldsOnce's regeneration, so this pins the final-contract
 * outcome rather than the regeneration itself.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const UNREAD_STEP = "Open the size dropdown in the catalogue and select the 'Large' size option";
const DECLARED_STEPS = [
  { step: "fill out applicant, address, contact, employment, and attachment sections" },

  { step: UNREAD_STEP, payloadField: "unreadSize" },
  { step: "submit address section", submitStep: true },
];

const NOISE_HOST = "https://api.example.com";
const TRIGGERING_NOISE_URL = `${NOISE_HOST}/site-banner`;

function triggeringNoiseCapture(): Capture {
  return {
    timestamp: "2024-01-01T00:00:00.400Z",
    phase: "home",
    method: "POST",
    url: TRIGGERING_NOISE_URL,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: '{"pageId":"home","landingUrl":"https://cdn.example.com/landing"}',
    responseHeaders: { "content-type": "application/json" },
    responseBody: {
      landingUrl: "https://cdn.example.com/banner.png",
      mobileWebBannerImageUrl: "https://cdn.example.com/banner-mobile.png",
    },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

function writeRunDir(runRoot: string, captures: Capture[]): void {
  const capturesDir = join(runRoot, "graphql");
  mkdirSync(capturesDir, { recursive: true });
  mkdirSync(join(runRoot, "replays"), { recursive: true });
  mkdirSync(join(runRoot, "aux"), { recursive: true });
  writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
  captures.forEach((capture, index) => {
    const filename = `${String(index).padStart(3, "0")}-capture.json`;
    writeFileSync(join(capturesDir, filename), JSON.stringify(capture));
  });
}

function runGenerate(siteId: string, runRoot: string): ReturnType<typeof spawnSync> {
  return spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
    { cwd: RECON_GENERATE_CWD, encoding: "utf8" }
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

describe("recon-generate CLI — unread declared facet after self-heal regeneration", () => {
  it("emits the unread field optional and warns once the noise capture is excluded", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-unread-facet-final-contract-"));
    const runRoot = join(workDir, "run");
    const actionCaptures = buildMultiEndpointSubmissionActionSteps().map((s) => s.capture);
    writeRunDir(runRoot, [
      actionCaptures[0]!,
      triggeringNoiseCapture(),
      ...actionCaptures.slice(1),
    ]);

    const siteId = `unread-facet-final-contract-e2e-test-${process.pid}`;
    siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(join(siteOutDir, "recon-flow.json"), JSON.stringify({ steps: DECLARED_STEPS }));

    const result = runGenerate(siteId, runRoot);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status, output).toBe(0);
    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    expect(contract).not.toContain("landingUrl");
    expect(output).toContain("declared payloadField unreadSize is read by no emitted request");
    expect(contract, contract).toMatch(/unreadSize: z\.string\(\)\.optional\(\)/);
    expect(contract, contract).not.toMatch(/unreadSize: z\.string\(\)(?!\.optional)/);
    expect(contract).not.toContain("payload.unreadSize");
    expect(unreferencedDeclaredPayloadFields(contract, "", DECLARED_STEPS)).toEqual(["unreadSize"]);
  }, 30_000);
});
