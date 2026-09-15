import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins the report's string/boolean cast mismatch on the PLAIN (non-fold)
 * sequential-step produce-extraction path (`recon-generate.ts` ~6746-6758) —
 * the sibling of {@link
 * "./recon-generate-1-12-51-produce-extraction-cast-boolean-leaf-type-parity-e2e.test.ts"}'s
 * per-item drill-hop chain path (~6696-6705). Both paths share the same
 * `pathToAssertionType` helper, but each is reached by a structurally
 * different code branch (fold-chain loop vs. the top-level per-step loop),
 * so a fixture with no items array / fold at all is needed to exercise this
 * one specifically. A detail step's response carries a top-level boolean
 * field (`specialOfferEnabled`) that is both response-schema-inferred as
 * `z.boolean()` AND genuinely re-threaded, under its own name, into the
 * submit step's request body — the same field `indexProduces` (via
 * `walkAllPrimitiveLeaves`) has always indexed for value-matching, but whose
 * extraction cast the stale `pathToAssertionType` invariant hardcoded to
 * `string` regardless of the field's real captured type.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.extraction-cast-schema-type-parity-guard-fixture.example.com";
const LIST_URL = `https://${OWN_BACKEND_HOST}/catalog/search/`;
const DETAIL_URL = `https://${OWN_BACKEND_HOST}/catalog/detail/`;
const SUBMIT_URL = `https://${OWN_BACKEND_HOST}/catalog/submit/`;

function fixtureCaptures(): Capture[] {
  const list = buildCapture({
    url: LIST_URL,
    requestPostData: '{"page":1}',
    responseBody: { results: [{ itemId: "item-a" }] },
    timestamp: "2026-06-01T00:00:00Z",
  });
  // A top-level boolean leaf, both response-schema-inferred as z.boolean()
  // AND genuinely re-threaded downstream under its own name.
  const detail = buildCapture({
    url: DETAIL_URL,
    requestPostData: '{"itemId":"item-a"}',
    responseBody: { specialOfferEnabled: true },
    timestamp: "2026-06-01T00:00:01Z",
  });
  const submit = buildCapture({
    url: SUBMIT_URL,
    requestPostData: JSON.stringify({ itemId: "item-a", specialOfferEnabled: true }),
    responseBody: { ok: true },
    timestamp: "2026-06-01T00:00:02Z",
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

describe("recon-generate CLI — plain sequential-step produce-extraction casts a boolean leaf as boolean", () => {
  it("emits `as { specialOfferEnabled: boolean }`, never `as { specialOfferEnabled: string }`, matching the field's own z.boolean() schema", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-extraction-cast-schema-type-parity-guard-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `extraction-cast-schema-type-parity-guard-test-${process.pid}`;
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
    expect(contract).toMatch(/specialOfferEnabled:\s*z\.boolean\(\)/);

    const castMatch = contract.match(/as \{ specialOfferEnabled: (\w+) \}/);
    expect(castMatch, contract).not.toBeNull();
    expect(castMatch![1]).toBe("boolean");
    expect(contract).not.toMatch(/as \{ specialOfferEnabled: string \}/);
  }, 30_000);
});
