import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Runs the real `recon:generate` CLI end to end (not the emitter function
 * directly) to pin the per-call header builder's two sibling loops
 * (recon-generate.ts's non-multipart `perCallHeaders` loop and its
 * multipart `perCallHeaderEntries` loop) never freezing a captured `Cookie`
 * header into the emitted contract.ts as a literal, across BOTH a
 * non-multipart and a multipart-style call in the same flow — a fix landing
 * in only one loop would leave the other half of the surface uncovered.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_HOST = "api.session-cookie-jar-not-frozen-fixture.example.com";
const FACET_VALUE = "december-2026-promo";
const LIST_URL = `https://${OWN_HOST}/catalog/search`;
const SUBMIT_URL = `https://${OWN_HOST}/catalog/submit`;
const UPLOAD_URL = `https://${OWN_HOST}/catalog/upload`;

/** Mirrors the finding's PHPSESSID / AMCV_* / ak_bmsc / facetFilters=...%2C...
 * / __pa repro shape: a session id, an analytics-tracker-style cookie pair, a
 * bot-manager-style cookie, a URL-encoded facet state param (which
 * partial-matches the registered `facetFilters` payload accessor), and a
 * JWT-shaped token — none of these are Set-Cookie-response-origin values. */
function unboundCookieJar(): string {
  return [
    "PHPSESSID=sess-9f8e7d6c5b4a3210",
    "AMCV_ADOBEORG=1234567890%7CMCIDTS%7C19999",
    "ak_bmsc=AK_BMSC_LONG_OPAQUE_VALUE_1234567890ABCDEF",
    `facetFilters=${encodeURIComponent(FACET_VALUE)}%2Cother-unrelated-value`,
    "__pa=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMyJ9.signaturepart",
  ].join("; ");
}

function fixtureCaptures(): Capture[] {
  const list = buildCapture({
    url: LIST_URL,
    requestPostData: JSON.stringify({ facetFilters: FACET_VALUE }),
    responseBody: { results: [{ itemId: "item-a" }] },
    timestamp: "2026-01-01T00:00:00Z",
  });
  const submit = buildCapture({
    url: SUBMIT_URL,
    requestPostData: JSON.stringify({ facetFilters: FACET_VALUE }),
    responseBody: { ok: true },
    requestHeaders: { "Content-Type": "application/json", Cookie: unboundCookieJar() },
    timestamp: "2026-01-01T00:00:01Z",
  });
  const upload = buildCapture({
    url: UPLOAD_URL,
    requestPostData: null,
    responseBody: { ok: true },
    requestHeaders: { "Content-Type": "multipart/form-data", Cookie: unboundCookieJar() },
    timestamp: "2026-01-01T00:00:02Z",
  });
  return [list, submit, upload];
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

describe("recon-generate CLI — a captured session cookie jar never freezes into a per-call header literal", () => {
  it("emits no Cookie/cookie per-call header entry, in either the non-multipart or multipart path, for the captured jar", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-session-cookie-jar-not-frozen-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `session-cookie-jar-not-frozen-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "browse catalog search" },
          { step: "submit catalog selection", submitStep: true },
          { step: "upload catalog asset" },
        ],
        submitEndpointPattern: "catalog/submit",
        requireSubmitEndpointMatch: true,
        ownBackendHostnames: [OWN_HOST],
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");

    // No per-call headers object entry keyed Cookie/cookie at all — the
    // fix removes the key entirely rather than partially interpolating it.
    expect(contract).not.toMatch(/["']?[Cc]ookie["']?\s*:/);

    // None of the jar's captured, time-limited values may survive as a
    // literal anywhere in the emitted contract, including the
    // partially-threadable facetFilters fragment.
    expect(contract).not.toContain("PHPSESSID=sess-9f8e7d6c5b4a3210");
    expect(contract).not.toContain("AMCV_ADOBEORG");
    expect(contract).not.toContain("ak_bmsc");
    expect(contract).not.toContain("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMyJ9");
    expect(contract).not.toContain(encodeURIComponent(FACET_VALUE));
  }, 30_000);
});
