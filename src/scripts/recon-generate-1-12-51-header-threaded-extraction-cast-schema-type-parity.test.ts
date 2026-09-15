import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins the report's string/boolean cast mismatch for the case neither
 * existing 1.12.51 regression test covers: the produced boolean is threaded
 * into a later request HEADER rather than a body field — the report's
 * actual repro (`"X-Use-Voyage-Svc": `${dclSpecialOfferRefactor}`) — so the
 * declaration line the header consumes is emitted, but never read back out
 * of a body template at all. `authorization` is a bare top-level boolean
 * leaf on the per-item drill hop's own response, name-correlated (the
 * `sameNameMatch` chain-detection {@link "@/scripts/recon-generate"}'s
 * `collectDependentDrillDownChainValues` performs) against the very next
 * hop's own `Authorization` request header of the SAME captured value — the
 * only header names {@link "@/scripts/recon-generate"} ever threads a
 * produced state value into are `Authorization`/`Api-Token` (or a
 * structurally-detected fold join-carrier), so this is the one realistic
 * shape that exercises header-only consumption. The capture pool also
 * carries an unrelated, differently-typed leaf (`sessionCode`, a STRING
 * that is itself echoed by name in the same submit body) stringifying to
 * the exact same text ("true") as the boolean, pinning that a
 * value-coincidence dedup keyed only on stringified value can't let it
 * claim origin ahead of `authorization`'s own genuine occurrence.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.header-threaded-extraction-cast-fixture.example.com";
const LIST_URL = `https://${OWN_BACKEND_HOST}/catalog/search/`;
const DETAIL_URL = `https://${OWN_BACKEND_HOST}/catalog/detail/`;
const SUBMIT_URL = `https://${OWN_BACKEND_HOST}/catalog/submit/`;

function fixtureCaptures(): Capture[] {
  const list = buildCapture({
    url: LIST_URL,
    requestPostData: '{"page":1}',
    responseBody: { results: [{ itemId: "item-a" }] },
    timestamp: "2026-07-01T00:00:00Z",
  });
  // Each per-item drill hop's own response carries a bare top-level boolean
  // leaf (`authorization`) — response-schema-inferred as z.boolean() — AND
  // an unrelated STRING leaf (`sessionCode`) that stringifies to the exact
  // same text, walked first.
  const detail = buildCapture({
    url: DETAIL_URL,
    requestPostData: '{"itemId":"item-a"}',
    responseBody: { sessionCode: "true", authorization: true },
    timestamp: "2026-07-01T00:00:01Z",
  });
  // The next hop re-sends `sessionCode` by name in its own body (the only
  // downstream signal that value ever legitimately threads), while
  // `authorization`'s only downstream reference is the Authorization
  // header of this SAME request — never any body field.
  const submit = buildCapture({
    url: SUBMIT_URL,
    requestPostData: '{"itemId":"item-a","sessionCode":"true"}',
    responseBody: { ok: true },
    requestHeaders: {
      "Content-Type": "application/json",
      Authorization: "true",
    },
    timestamp: "2026-07-01T00:00:02Z",
  });
  return [list, detail, submit];
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

describe("recon-generate CLI — header-threaded produce-extraction casts a boolean leaf as boolean", () => {
  it("emits `as { authorization: boolean }`, never `as { authorization: string }`, when the field is only ever re-read into a request header, and an unrelated string leaf stringifying to the same value never claims origin", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-header-threaded-extraction-cast-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `header-threaded-extraction-cast-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "browse catalog search" },
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

    // The detail step's own response schema infers the SAME field as
    // z.boolean() — the extraction cast below must agree with it.
    expect(contract).toMatch(/authorization:\s*z\.boolean\(\)/);

    const castMatch = contract.match(/as \{ authorization: (\w+) \}/);
    expect(castMatch, contract).not.toBeNull();
    expect(castMatch![1]).toBe("boolean");
    expect(contract).not.toMatch(/as \{ authorization: string \}/);

    // The header itself must actually thread the produced var, otherwise
    // this fixture isn't exercising the header path at all.
    expect(contract).toMatch(/"Authorization":\s*`\$\{authorization\}`/);
  }, 30_000);
});
