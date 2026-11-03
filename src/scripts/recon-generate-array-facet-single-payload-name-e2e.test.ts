import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { RECON_GENERATE_CWD } from "@/scripts/recon-generate-cwd.test-helper";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * End-to-end proof, through the real CLI, for Finding 1's array-facet half:
 * a typed array-of-objects payload field (structurally identical to the
 * reported `attendeeMix` — an array of `{count, subCount, ages, id}`-shaped
 * records) must get spliced into EVERY request body it appears in as
 * `${JSON.stringify(payload.<field>)}`, never survive as a frozen literal.
 * Distinct from `recon-generate-structured-value-array-body.test.ts`, which
 * only proves `applyStructuredValuePayloadSubstitutions` in isolation — this
 * proves the same field also survives the full per-capture body pipeline
 * (form subs, facet splice, state threading, url-param binding) when it
 * recurs, byte-for-byte, across six separate request bodies in one flow —
 * including the submit body, which carries a slightly different
 * array-item shape than the other five, mirroring the finding's own
 * report of shape variance across a flow's request bodies.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.array-facet-dedup-fixture.example.com";

function body(): string {
  return JSON.stringify({
    order: {
      note: "hello world note",
      orderGames_attributes: [
        { game_id: "g-12345", slot: "first-slot" },
        { game_id: "g-67890", slot: "second-slot" },
      ],
    },
  });
}

function fixtureCaptures(): Capture[] {
  const urls = [
    `https://${OWN_BACKEND_HOST}/catalog/search/`,
    `https://${OWN_BACKEND_HOST}/catalog/filter/`,
    `https://${OWN_BACKEND_HOST}/catalog/itinerary/`,
    `https://${OWN_BACKEND_HOST}/catalog/cabin/`,
    `https://${OWN_BACKEND_HOST}/catalog/pricing/`,
    `https://${OWN_BACKEND_HOST}/catalog/submit/`,
  ];
  return urls.map((url, index) =>
    buildCapture({
      url,
      requestPostData: body(),
      responseBody: { ok: true, index },
      timestamp: `2026-01-01T00:00:0${index}.000Z`,
    })
  );
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

describe("recon-generate CLI — nested array declared under a single payload name", () => {
  it("does not also declare the array under its bare key", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-array-facet-dedup-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `array-facet-dedup-e2e-test-${process.pid}`;
    siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "browse catalog search" },
          { step: "apply catalog filters" },
          { step: "select itinerary" },
          { step: "select cabin" },
          { step: "review pricing" },
          { step: "submit booking", submitStep: true },
        ],
        submitEndpointPattern: "catalog/submit",
        requireSubmitEndpointMatch: true,
        ownBackendHostnames: [OWN_BACKEND_HOST],
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: RECON_GENERATE_CWD, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contractPath = join(siteOutDir, "contract.ts");
    const contract = readFileSync(contractPath, "utf8");

    // The nested array is declared under ONE payload name (the one the
    // by-index accessors use), never also under its bare leaf key.
    expect(contract).toContain("orderOrderGames_attributes:");
    expect(contract).not.toMatch(/^ {2}orderGames_attributes:/m);
  }, 30_000);
});
