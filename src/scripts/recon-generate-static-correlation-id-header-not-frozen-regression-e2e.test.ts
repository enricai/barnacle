import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins the fix for a session-correlation-id-shaped custom header that is
 * IDENTICAL on every action-step request and never sourced from any
 * captured response: the generator must not sort it into the static
 * BASE_HEADERS bucket and freeze it as a literal — it must either omit it
 * from BASE_HEADERS or re-mint it per call, mirroring the precedent set for
 * the declared-filter-unwired warning. A sibling control case pins that a
 * genuinely stable, non-session-scoped static header (e.g. an API realm
 * identifier) still passes through to BASE_HEADERS unchanged, so the fix
 * can't be satisfied by blanket-stripping all static headers. Runs the real
 * CLI end to end against a run-dir fixture so the assertion covers the
 * whole emitted file, not one named emission site.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.static-correlation-id-header-fixture.example.com";
const SEARCH_URL = `https://${OWN_BACKEND_HOST}/catalog/search/`;
const HOLD_URL = `https://${OWN_BACKEND_HOST}/catalog/hold/`;
const CONFIRM_URL = `https://${OWN_BACKEND_HOST}/catalog/confirm/`;

const CORRELATION_ID = "3f9e2b1a-6d4c-4a7e-9c2f-1a2b3c4d5e6f";
const STABLE_REALM_HEADER_VALUE = "acme-catalog-realm-v2";

function fixtureCaptures(): Capture[] {
  const headers = {
    "Content-Type": "application/json",
    "X-Correlation-Id": CORRELATION_ID,
    "API-Realm": STABLE_REALM_HEADER_VALUE,
  };
  const search = buildCapture({
    url: SEARCH_URL,
    requestPostData: JSON.stringify({ query: "lakeside" }),
    responseBody: { results: [{ unitId: "unit-a" }] },
    requestHeaders: headers,
    timestamp: "2026-05-01T00:00:00Z",
  });
  const hold = buildCapture({
    url: HOLD_URL,
    requestPostData: JSON.stringify({ unitId: "unit-a" }),
    responseBody: { held: true },
    requestHeaders: headers,
    timestamp: "2026-05-01T00:00:01Z",
  });
  const confirm = buildCapture({
    url: CONFIRM_URL,
    requestPostData: JSON.stringify({ unitId: "unit-a" }),
    responseBody: { confirmed: true },
    requestHeaders: headers,
    timestamp: "2026-05-01T00:00:02Z",
  });
  return [search, hold, confirm];
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

describe("recon-generate CLI — a session-correlation-id-shaped static header never freezes into BASE_HEADERS", () => {
  it("omits or re-mints the UUID-shaped correlation-id header, while a genuinely stable static header still passes through unchanged", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-static-correlation-id-header-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `static-correlation-id-header-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "search the catalog for a lakeside unit" },
          { step: "place a hold on the selected unit" },
          { step: "confirm the unit hold", submitStep: true },
        ],
        submitEndpointPattern: "catalog/confirm",
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

    const baseHeadersBlock = contract.match(/BASE_HEADERS[^{]*\{[\s\S]*?\n\};/)?.[0] ?? contract;
    const generationWarnedAboutCorrelationId = /correlation-id/i.test(result.stderr);

    // Either the raw session-scoped UUID never lands in BASE_HEADERS as a
    // frozen literal, or generation surfaces a warning naming the header —
    // mirroring the declared-filter-unwired precedent.
    if (!generationWarnedAboutCorrelationId) {
      expect(baseHeadersBlock).not.toContain(CORRELATION_ID);
    }

    // Control: a genuinely stable, non-session-scoped static header must
    // still pass through to BASE_HEADERS unchanged — the fix must not
    // over-correct into stripping every static header.
    expect(contract).toContain(STABLE_REALM_HEADER_VALUE);
  }, 30_000);
});
