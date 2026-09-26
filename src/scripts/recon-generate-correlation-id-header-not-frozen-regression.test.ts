import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins BASE_HEADERS derivation (deriveRequestHeaders, recon-generate.ts:1227+,
 * feeding emitContractTs's headersLiteral emission) so a session-scoped
 * correlation/conversation-id-style header — present with a UUID-shaped
 * value in every relevant capture, and therefore admitted into the static
 * baseline the same way a real load-bearing header would be — never freezes
 * that captured value as a permanent literal. deriveRequestHeaders only
 * excludes header NAMES via IGNORE_REQUEST_HEADERS; it has no value-shape
 * check, so without the fix a consistent-looking UUID sails into BASE_HEADERS
 * verbatim, unlike the volatile-field convention already applied to body
 * leaves (UUID_REGEX, recon-generate.ts:3069) via
 * applyVolatileFieldSubstitutions.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "api.correlation-id-header-fixture.example.com";
const SEARCH_URL = `https://${OWN_BACKEND_HOST}/catalog/search`;
const SUBMIT_URL = `https://${OWN_BACKEND_HOST}/catalog/submit`;

const CORRELATION_ID_HEADER = "X-Correlation-Id";
const CORRELATION_ID_VALUE = "a1b2c3d4-e5f6-4789-a012-3456789abcde";
const CONVERSATION_ID_HEADER = "X-Conversation-Id";
const CONVERSATION_ID_VALUE = "f9e8d7c6-b5a4-4321-9876-fedcba987654";

function correlatedHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    [CORRELATION_ID_HEADER]: CORRELATION_ID_VALUE,
    [CONVERSATION_ID_HEADER]: CONVERSATION_ID_VALUE,
  };
}

function fixtureCaptures(): Capture[] {
  return [
    buildCapture({
      url: SEARCH_URL,
      requestPostData: JSON.stringify({ query: "widgets" }),
      responseBody: { results: [{ itemId: "item-a" }] },
      timestamp: "2026-01-01T00:00:00Z",
      requestHeaders: correlatedHeaders(),
    }),
    buildCapture({
      url: SUBMIT_URL,
      requestPostData: JSON.stringify({ itemId: "item-a" }),
      responseBody: { ok: true },
      timestamp: "2026-01-01T00:00:01Z",
      requestHeaders: correlatedHeaders(),
    }),
  ];
}

function writeRunDir(root: string, captures: Capture[]): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));
  captures.forEach((capture, index) => {
    writeFileSync(
      join(root, "graphql", `${String(index).padStart(4, "0")}-capture.json`),
      JSON.stringify(capture)
    );
  });
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate CLI — a correlation/conversation-id header is never frozen into BASE_HEADERS", () => {
  it("emits BASE_HEADERS without the captured UUID literal for either header key", () => {
    const captures = fixtureCaptures();

    workDir = mkdtempSync(join(tmpdir(), "barnacle-correlation-id-header-not-frozen-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, captures);

    const siteId = `correlation-id-header-not-frozen-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "search catalog" }, { step: "submit selected item", submitStep: true }],
        submitEndpointPattern: "catalog/submit",
        requireSubmitEndpointMatch: true,
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
    const baseHeadersMatch = contract.match(/BASE_HEADERS[^{]*=\s*\{[\s\S]*?\n\};/);
    expect(baseHeadersMatch, contract).not.toBeNull();
    const baseHeadersLiteral = baseHeadersMatch![0];

    // The captured UUID values must never appear as a frozen literal
    // anywhere in the emitted BASE_HEADERS object, regardless of whether
    // the fix omits the keys or mints them fresh via a generator call.
    expect(baseHeadersLiteral).not.toContain(CORRELATION_ID_VALUE);
    expect(baseHeadersLiteral).not.toContain(CONVERSATION_ID_VALUE);

    // If either key survived into the baseline, it must be emitted as a
    // fresh-mint expression, not a plain JSON string literal of the value.
    const correlationKeyPresent = new RegExp(`["']?${CORRELATION_ID_HEADER}["']?\\s*:`).test(
      baseHeadersLiteral
    );
    const conversationKeyPresent = new RegExp(`["']?${CONVERSATION_ID_HEADER}["']?\\s*:`).test(
      baseHeadersLiteral
    );
    if (correlationKeyPresent) {
      expect(baseHeadersLiteral).toMatch(
        new RegExp(`${CORRELATION_ID_HEADER}["']?\\s*:\\s*\`\\$\\{crypto\\.randomUUID\\(\\)\\}\``)
      );
    }
    if (conversationKeyPresent) {
      expect(baseHeadersLiteral).toMatch(
        new RegExp(`${CONVERSATION_ID_HEADER}["']?\\s*:\\s*\`\\$\\{crypto\\.randomUUID\\(\\)\\}\``)
      );
    }
  }, 60_000);
});
