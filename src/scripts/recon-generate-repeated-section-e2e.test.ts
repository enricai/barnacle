import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildRepeatedSectionSubmissionCaptures } from "@/scripts/recon-generate-repeated-section-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * CLI regression suite for recon-generate emitting a bogus HTTP stub for a
 * repeated-section multi-call flow, run through the real `recon-generate` entry point (spawnSync tsx) rather
 * than only the exported unit-level functions, so the fix is proven at the
 * same surface the bug report used. Uses the repeated-section fixture (an
 * id threaded into every URL PATH, one leaf hit many times with distinct
 * bodies) — a shape not covered by recon-generate-multiendpoint-detection.test.ts's
 * static-leaf fixture.
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

function writeRunDir(captures: Capture[], manifestCaptureIndex: number | null): string {
  workDir = mkdtempSync(join(tmpdir(), "barnacle-recon-repeated-section-"));
  const runRoot = join(workDir, "run");
  const capturesDir = join(runRoot, "graphql");
  const replaysDir = join(runRoot, "replays");
  const auxDir = join(runRoot, "aux");
  mkdirSync(capturesDir, { recursive: true });
  mkdirSync(replaysDir, { recursive: true });
  mkdirSync(auxDir, { recursive: true });
  writeFileSync(join(replaysDir, "rate-limit.json"), JSON.stringify([]));

  const filenames = captures.map(
    (_, index) => `${String(index).padStart(3, "0")}-application-action.json`
  );
  captures.forEach((capture, index) => {
    writeFileSync(join(capturesDir, filenames[index]!), JSON.stringify(capture));
  });

  if (manifestCaptureIndex !== null) {
    const capture = captures[manifestCaptureIndex];
    if (!capture) throw new Error("unreachable");
    writeFileSync(
      join(runRoot, "submit-manifest.json"),
      JSON.stringify([
        {
          index: manifestCaptureIndex,
          filename: filenames[manifestCaptureIndex]!,
          url: capture.url,
        },
      ])
    );
  }

  return runRoot;
}

function runGenerate(runRoot: string): { contract: string; result: ReturnType<typeof spawnSync> } {
  const siteId = `recon-repeated-section-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
  siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({
      steps: [
        { step: "fill out the applicant, address, contact, employment, and attachments sections" },
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
  return { contract, result };
}

describe("recon-generate CLI: repeated-section multi-call fixture must not emit the fabricated {query} stub", () => {
  it("no fabricated stub without a submit-manifest.json (heuristic-only path)", () => {
    const captures = buildRepeatedSectionSubmissionCaptures();
    const runRoot = writeRunDir(captures, null);
    const { contract } = runGenerate(runRoot);

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

  it("no fabricated stub with a submit-manifest.json that under-covers the real sequence", () => {
    const captures = buildRepeatedSectionSubmissionCaptures();
    // An under-covering manifest: only the final validate call is
    // authoritatively matched against the flow's declared submit step, even
    // though every other section-save/validate call was also captured.
    const runRoot = writeRunDir(captures, captures.length - 1);
    const { contract } = runGenerate(runRoot);

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

describe("recon-generate CLI: preferred branch synthesizes the real per-section call sequence", () => {
  it("threads the created record id into every URL and pins ResponseSchema to the terminal validate call's own body", () => {
    const captures = buildRepeatedSectionSubmissionCaptures();
    const runRoot = writeRunDir(captures, null);
    const { contract } = runGenerate(runRoot);

    expect(contract).toContain("async executeHttp(");
    // Every distinct URL path from the fixture is present.
    expect(contract).toContain("/applications`");
    expect(contract).toContain(`/applications/\${applicationId}/applicant`);
    expect(contract).toContain(`/applications/\${applicationId}/address`);
    expect(contract).toContain(`/applications/\${applicationId}/contact`);
    expect(contract).toContain(`/applications/\${applicationId}/employment`);
    expect(contract).toContain(`/applications/\${applicationId}/attachments`);
    expect(contract).toContain(`/applications/\${applicationId}/validate`);

    // ResponseSchema is pinned to the terminal validate call's own captured
    // success body (`{ valid, revision }`), not z.unknown().
    expect(contract).not.toMatch(/ResponseSchema = z\.unknown\(\);/);
    expect(contract).toMatch(
      /ResponseSchema = z\.object\(\{\s*\n\s*valid: z\.boolean\(\),\s*\n\s*revision: z\.number\(\),\s*\n\s*\}\);/
    );
  }, 30_000);
});

describe("recon-generate CLI: unsynthesizable repeated-section variant falls back to browser-flow-only", () => {
  it("omits executeHttp and emits the standard candidate payload schema when the sequence can't be faithfully replayed as bare fetch", () => {
    const captures = buildRepeatedSectionSubmissionCaptures();
    // Same trigger recon-generate-browser-flow-only.test.ts already proves for
    // the static-leaf fixture: the captured sequence hops to a different host
    // mid-flow, which a bare-fetch executeHttp can't faithfully replay
    // (cookies/CSRF/session state minted for one origin don't automatically
    // carry to another the way a real browser redirect does).
    const last = captures[captures.length - 1]!;
    captures[captures.length - 1] = {
      ...last,
      url: last.url.replace("https://api.example.com", "https://payments.example.net"),
    };
    const filenames = captures.map(
      (_, index) => `${String(index).padStart(3, "0")}-application-action.json`
    );
    const runRoot = writeRunDir(captures, null);
    // extractActionSequence's own heuristic drops any capture off the run's
    // baseUrl host outright — a submit-manifest.json is the one path that
    // carries a cross-host entry through to compileActionSteps at all.
    writeFileSync(
      join(runRoot, "submit-manifest.json"),
      JSON.stringify(
        captures.map((capture, index) => ({ index, filename: filenames[index]!, url: capture.url }))
      )
    );

    const { contract } = runGenerate(runRoot);

    expect(contract).not.toContain("async executeHttp(");
    expect(contract).not.toContain("query: payload.query");
    expect(contract).not.toContain("query: z.string().min(1)");
    expect(contract).toContain(
      "ApplicantContactSchema.extend({\n  Email: z.email(),\n  ClickUrl: z.string().min(1),\n  Answers: multipartJsonObject(z.record(z.string(), z.unknown())),\n})"
    );
  }, 30_000);
});
