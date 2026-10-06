import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins that two required array facets are spliced at every REST call site
 * whatever the element order, the arrays' differing contents, or a
 * look-alike element elsewhere, while unrelated elements stay literal and no
 * by-index `payload.filters[...]` accessor is emitted. Generic
 * library-catalog fixture.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.array-facet-path-owner-fixture.example.com";
const DELIMITER = ";src=facet";
const AUTHOR_TOKEN = "authorx-shelf-7001";
const GENRE_TOKEN = "genrex-shelf-7002";

function tagged(token: string): string {
  return `${token}${DELIMITER}`;
}

function fixtureCaptures(): Capture[] {
  const bodies = [
    { search: { filters: [tagged(AUTHOR_TOKEN), tagged(GENRE_TOKEN)], page: 1 }, mode: "a" },
    { search: { filters: ["plain-one", "plain-two-long"], page: 2 }, mode: "b" },
  ];
  return bodies.map((body, index) =>
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/library/lookup-${index}/`,
      requestPostData: JSON.stringify(body),
      responseBody: { ok: true },
      timestamp: `2026-06-01T00:00:0${index}.000Z`,
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

describe("recon-generate CLI — required array facets at every call site", () => {
  it("splices both facets in every array and leaves unrelated elements literal", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-array-facet-path-owner-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());
    const siteId = `array-facet-path-owner-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    const base = `https://${OWN_BACKEND_HOST}/#/library`;
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          {
            step: "navigate to the shelf with the author facet applied",
            navigateTo: `${base}/author/${AUTHOR_TOKEN}`,
            payloadField: "AuthorFacet",
          },
          {
            step: "navigate to the shelf with the genre facet applied",
            navigateTo: `${base}/author/${AUTHOR_TOKEN}/genre/${GENRE_TOKEN}`,
            payloadField: "GenreFacet",
          },
          { step: "look up books", submitStep: true },
        ],
        submitEndpointPattern: "library/lookup-1",
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
    expect(contract).not.toContain("JSON.stringify(payload.search)");
    expect(contract).not.toMatch(/payload\.(search|filters)\[/);
    expect(contract).toContain(`"filters":["plain-one","plain-two-long"]`);
    expect(contract).toContain(`"\${payload.AuthorFacet}${DELIMITER}"`);
    expect(contract).toContain(`"\${payload.GenreFacet}${DELIMITER}"`);
  }, 30_000);
});
