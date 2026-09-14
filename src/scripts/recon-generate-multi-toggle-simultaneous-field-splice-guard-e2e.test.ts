import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins the report's defect against a SINGLE unrelated response object whose
 * TWO boolean fields are simultaneously mis-threaded into two differently-
 * named request-body fields on the same submit call, rather than the
 * one-collision-per-response-object shape the sibling guard test plants.
 * A page-load "feature flags"-like call returns two booleans that
 * coincidentally equal two later, unrelated submit-body booleans; neither
 * may be spliced from the shared toggle-response local's own derived name.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.multi-toggle-splice-guard-fixture.example.com";
const LIST_URL = `https://${OWN_BACKEND_HOST}/catalog/search/`;
const FLAGS_URL = `https://${OWN_BACKEND_HOST}/catalog/flags/`;
const DETAIL_URL = `https://${OWN_BACKEND_HOST}/catalog/detail/`;
const SUBMIT_URL = `https://${OWN_BACKEND_HOST}/catalog/submit/`;

// The genuinely-threaded value: same field name on both sides.
const TOKEN_VALUE = "tok9";

// The two deliberately-planted, unrelated-name boolean coincidences, both
// sourced from the SAME unrelated feature-flags-like response object.
const FLAG_ALPHA_VALUE = true;
const FLAG_BETA_VALUE = false;

function fixtureCaptures(): Capture[] {
  const list = buildCapture({
    url: LIST_URL,
    requestPostData: '{"page":1}',
    responseBody: { results: [{ itemId: "item-a" }] },
    timestamp: "2026-01-01T00:00:00Z",
  });
  // A single unrelated response object carrying two booleans that will
  // later coincidentally equal two differently-named submit-body fields.
  const flags = buildCapture({
    url: FLAGS_URL,
    requestPostData: "{}",
    responseBody: { flagAlpha: FLAG_ALPHA_VALUE, flagBeta: FLAG_BETA_VALUE },
    timestamp: "2026-01-01T00:00:01Z",
  });
  const detail = buildCapture({
    url: DETAIL_URL,
    requestPostData: '{"itemId":"item-a"}',
    responseBody: { token: TOKEN_VALUE },
    timestamp: "2026-01-01T00:00:02Z",
  });
  // The submit body re-references `token` under its own genuine name, plus
  // two collision-shaped booleans whose names have nothing to do with the
  // shared unrelated flags-response fields their values coincidentally
  // equal.
  const submit = buildCapture({
    url: SUBMIT_URL,
    requestPostData: JSON.stringify({
      itemId: "item-a",
      token: TOKEN_VALUE,
      allowSubstitutions: FLAG_ALPHA_VALUE,
      includeGiftWrap: FLAG_BETA_VALUE,
    }),
    responseBody: { ok: true },
    timestamp: "2026-01-01T00:00:03Z",
  });
  return [list, flags, detail, submit];
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

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate CLI — one shared unrelated response never simultaneously sources two differently-named body fields", () => {
  it("sources each collision-shaped body field only from its own name-correlated accessor, never the shared unrelated toggle-response local", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-multi-toggle-splice-guard-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `multi-toggle-splice-guard-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "browse catalog search" },
          { step: "load feature flags" },
          { step: "open item detail panel" },
          { step: "submit item selection", submitStep: true },
        ],
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

    const bodyLineMatch = contract.match(/catalog\/submit\/[\s\S]*?body:\s*`([^`]*)`/);
    expect(bodyLineMatch, contract).not.toBeNull();
    const bodyTemplate = bodyLineMatch![1]!;

    // The genuinely-threaded field must still resolve from its own
    // name-correlated accessor/local — the fix must not over-correct into
    // blocking legitimate same-name threading.
    const tokenLine = bodyTemplate.match(/"token"\s*:\s*"?\$\{([^}]*)\}"?/);
    expect(tokenLine, bodyTemplate).not.toBeNull();
    expect(tokenLine![1]).toMatch(/token/i);

    // Neither boolean may be spliced from the shared unrelated
    // flags-response local's own derived name ("flagAlpha"/"flagBeta"),
    // even though both were planted on the SAME response object at once.
    const allowSubstitutionsLine = bodyTemplate.match(/"allowSubstitutions"\s*:\s*"?([^,\n}]*)"?/);
    if (allowSubstitutionsLine && allowSubstitutionsLine[1]!.includes("${")) {
      expect(allowSubstitutionsLine[1]).not.toMatch(/flagalpha|flagbeta/i);
    }

    const includeGiftWrapLine = bodyTemplate.match(/"includeGiftWrap"\s*:\s*"?([^,\n}]*)"?/);
    if (includeGiftWrapLine && includeGiftWrapLine[1]!.includes("${")) {
      expect(includeGiftWrapLine[1]).not.toMatch(/flagalpha|flagbeta/i);
    }

    // No invalidly-nested placeholder anywhere in the emitted body.
    expect(bodyTemplate).not.toMatch(/\$\{[^}]*\$\{/);
  }, 30_000);
});
