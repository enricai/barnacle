import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins the report's string/boolean cast mismatch (`dclSpecialOfferRefactor`
 * cast as `string` despite the response schema inferring `z.boolean()`) on
 * the one shape neither existing 1.12.51 header regression test covers: a
 * CUSTOM header name — not `Authorization`, not `Api-Token`, and not a
 * structurally-detected join-carrying header (the drill-hop-to-primary-item
 * correlation {@link "@/scripts/recon-generate"}'s `joinCarryingHeaderNamesByStep`
 * detects). `recon-generate-1-12-51-header-threaded-extraction-cast-schema-
 * type-parity.test.ts` pins this exact bug shape but only for the
 * `Authorization` name; that header (and `Api-Token`) is the ONLY name the
 * per-call header builder recognized before this fixture's fix, so a
 * custom-named header carrying the very same produced boolean was silently
 * frozen into `BASE_HEADERS` as an invariant literal instead of being
 * threaded per-call at all — never emitting the `as {...}` cast this test
 * checks.
 *
 * `verified` is a bare top-level boolean leaf on the per-item drill hop's
 * own response, response-schema-inferred as `z.boolean()`. Its captured
 * text (`"true"`/`"false"`) is below `MIN_STATE_VALUE_LENGTH`, so — exactly
 * like the sibling Authorization-header test — it only survives the
 * short-value drop gate by piggy-backing on `sessionCode`, an UNRELATED
 * STRING leaf on the SAME response walked first, whose own value the next
 * hop's body genuinely re-sends BY NAME (the only legitimate way a value
 * this short earns chain-threading eligibility at all). `verified`'s only
 * downstream reference is the next hop's own custom `X-Item-Verified`
 * request header of the SAME captured value — never any body field. Two
 * items with genuinely differing values (`true`/`false`) rule out the
 * header collapsing into an invariant `BASE_HEADERS` entry that would read
 * correctly only by coincidence.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.custom-header-extraction-cast-fixture.example.com";
const LIST_URL = `https://${OWN_BACKEND_HOST}/catalog/search/`;
const DETAIL_URL = `https://${OWN_BACKEND_HOST}/catalog/detail/`;
const SUBMIT_URL = `https://${OWN_BACKEND_HOST}/catalog/submit/`;

function fixtureCaptures(): Capture[] {
  const list = buildCapture({
    url: LIST_URL,
    requestPostData: '{"page":1}',
    responseBody: { results: [{ itemId: "item-a" }, { itemId: "item-b" }] },
    timestamp: "2026-08-01T00:00:00Z",
  });
  // Each per-item drill hop's own response carries a bare top-level boolean
  // leaf (`verified`) — response-schema-inferred as z.boolean() — AND an
  // unrelated STRING leaf (`sessionCode`) that stringifies to the exact same
  // text, walked first. `sessionCode`'s own legitimate name-correlated echo
  // in the next hop's body is what earns the shared short value
  // ("true"/"false") chain-threading eligibility at all.
  const detailA = buildCapture({
    url: DETAIL_URL,
    requestPostData: '{"itemId":"item-a"}',
    responseBody: { sessionCode: "true", verified: true },
    timestamp: "2026-08-01T00:00:01Z",
  });
  // The next hop re-sends `sessionCode` by name in its own body (the only
  // downstream signal that value ever legitimately threads), while
  // `verified`'s only downstream reference is this custom,
  // non-Authorization/Api-Token header of the SAME request — never any body
  // field.
  const submitA = buildCapture({
    url: SUBMIT_URL,
    requestPostData: '{"itemId":"item-a","sessionCode":"true"}',
    responseBody: { ok: true },
    requestHeaders: {
      "Content-Type": "application/json",
      "X-Item-Verified": "true",
    },
    timestamp: "2026-08-01T00:00:02Z",
  });
  // A second item with the OPPOSITE boolean value rules out the header
  // collapsing into an invariant BASE_HEADERS literal (present-in-every-call
  // with the SAME text) that would read correctly only by coincidence.
  const detailB = buildCapture({
    url: DETAIL_URL,
    requestPostData: '{"itemId":"item-b"}',
    responseBody: { sessionCode: "false", verified: false },
    timestamp: "2026-08-01T00:00:03Z",
  });
  const submitB = buildCapture({
    url: SUBMIT_URL,
    requestPostData: '{"itemId":"item-b","sessionCode":"false"}',
    responseBody: { ok: true },
    requestHeaders: {
      "Content-Type": "application/json",
      "X-Item-Verified": "false",
    },
    timestamp: "2026-08-01T00:00:04Z",
  });
  return [list, detailA, submitA, detailB, submitB];
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

describe("recon-generate CLI — custom-header-threaded produce-extraction casts a boolean leaf as boolean", () => {
  it("emits `as { verified: boolean }`, never `as { verified: string }`, when the field is only ever re-read into a CUSTOM (non-Authorization/Api-Token, non-join-carrying) request header", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-custom-header-extraction-cast-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `custom-header-extraction-cast-test-${process.pid}`;
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
    expect(contract).toMatch(/verified:\s*z\.boolean\(\)/);

    const castMatch = contract.match(/as \{ verified: (\w+) \}/);
    expect(castMatch, contract).not.toBeNull();
    expect(castMatch![1]).toBe("boolean");
    expect(contract).not.toMatch(/as \{ verified: string \}/);

    // The custom header itself must actually thread the produced var
    // per-call, otherwise this fixture isn't exercising the custom-header
    // path at all — it must never be frozen as a single invariant literal
    // in BASE_HEADERS (which would silently ignore the two items' differing
    // values).
    expect(contract).toMatch(/"X-Item-Verified":\s*`\$\{verified\}`/);
  }, 30_000);
});
