import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins the fix for a session cookie jar that is IDENTICAL on every
 * action-step request and never minted by any captured Set-Cookie in the
 * same run: with nothing for the dynamic bind mechanism to attach it to,
 * the generator must drop the header rather than freeze the raw jar string
 * verbatim into the generated contract — neither in BASE_HEADERS nor in any
 * per-call headers literal. Runs the real CLI end to end against a run-dir
 * fixture so the assertion covers the whole emitted file, not one named
 * emission site.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.static-frozen-session-cookie-jar-fixture.example.com";
const SEARCH_URL = `https://${OWN_BACKEND_HOST}/booking/search/`;
const HOLD_URL = `https://${OWN_BACKEND_HOST}/booking/hold/`;
const CONFIRM_URL = `https://${OWN_BACKEND_HOST}/booking/confirm/`;

const SESSION_ID_PAIR = "sessionId=9c2f1a2b3c4d5e6f7a8b9c0d1e2f3a4b";
const JWT_SHAPED_PAIR =
  "authJwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMyJ9.4a3e2f1b9c8d7e6f5a4b3c2d1e0f9a8b";
const CSRF_PAIR = "csrfGuard=f1e2d3c4b5a6978869504132241536475869";
const STATIC_COOKIE_JAR = `${SESSION_ID_PAIR}; ${JWT_SHAPED_PAIR}; ${CSRF_PAIR}`;

const STATIC_MARKER_HEADER_VALUE = "storefront-web-v3";

function fixtureCaptures(): Capture[] {
  const search = buildCapture({
    url: SEARCH_URL,
    requestPostData: JSON.stringify({ query: "lakeside" }),
    responseBody: { results: [{ unitId: "unit-a" }] },
    requestHeaders: {
      "Content-Type": "application/json",
      Cookie: STATIC_COOKIE_JAR,
      "X-Client-Name": STATIC_MARKER_HEADER_VALUE,
    },
    timestamp: "2026-05-01T00:00:00Z",
  });
  const hold = buildCapture({
    url: HOLD_URL,
    requestPostData: JSON.stringify({ unitId: "unit-a" }),
    responseBody: { held: true },
    requestHeaders: {
      "Content-Type": "application/json",
      Cookie: STATIC_COOKIE_JAR,
      "X-Client-Name": STATIC_MARKER_HEADER_VALUE,
    },
    timestamp: "2026-05-01T00:00:01Z",
  });
  const confirm = buildCapture({
    url: CONFIRM_URL,
    requestPostData: JSON.stringify({ unitId: "unit-a" }),
    responseBody: { confirmed: true },
    requestHeaders: {
      "Content-Type": "application/json",
      Cookie: STATIC_COOKIE_JAR,
      "X-Client-Name": STATIC_MARKER_HEADER_VALUE,
    },
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

describe("recon-generate CLI — a never-produced, identical-on-every-call cookie jar never freezes as a literal header", () => {
  it("never emits the raw captured Cookie header (or any of its pairs) verbatim, and still emits the flow's other static headers", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-static-frozen-session-cookie-jar-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `static-frozen-session-cookie-jar-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "search for a lakeside unit" },
          { step: "place a hold on the selected unit" },
          { step: "confirm the unit hold", submitStep: true },
        ],
        submitEndpointPattern: "booking/confirm",
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

    // The raw jar, and each of its individual cookie-pair substrings, must
    // never appear verbatim anywhere in the generated file.
    expect(contract).not.toContain(STATIC_COOKIE_JAR);
    expect(contract).not.toContain(SESSION_ID_PAIR);
    expect(contract).not.toContain(JWT_SHAPED_PAIR);
    expect(contract).not.toContain(CSRF_PAIR);

    // The flow's other, genuinely-static header survives unaffected.
    expect(contract).toContain(STATIC_MARKER_HEADER_VALUE);
  }, 30_000);
});
