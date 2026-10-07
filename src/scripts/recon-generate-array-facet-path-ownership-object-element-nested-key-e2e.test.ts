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

const OWN_BACKEND_HOST = "www.array-facet-path-objelem-fixture.example.com";
const DELIMITER = ";src=facet";
const AUTHOR_TOKEN = "authorx-shelf-7001";

function tagged(token: string): string {
  return `${token}${DELIMITER}`;
}

function fixtureCaptures(): Capture[] {
  const bodies = [
    { query: { tags: [tagged(AUTHOR_TOKEN)], items: [{ tags: "alpha-one", rank: 1 }] }, mode: "a" },
    { query: { tags: ["plain-one"], items: [{ tags: "beta-two-long", rank: 2 }] }, mode: "b" },
    {
      query: { tags: ["plain-two", "plain-three"], items: [{ tags: "gamma-three", rank: 3 }] },
      mode: "c",
    },
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

describe("recon-generate CLI — facet array with an object-element array sharing a nested key name", () => {
  it("emits no by-index or whole-array accessor for the facet array at any of 3 sites", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-array-facet-path-objelem-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());
    const siteId = `array-facet-path-objelem-test-${process.pid}`;
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
          { step: "look up books", submitStep: true },
        ],
        submitEndpointPattern: "library/lookup-2",
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
    expect(contract).not.toMatch(/payload\.tags\[/);
    expect(contract).not.toContain("JSON.stringify(payload.tags)");
    expect(contract).toContain("payload.AuthorFacet");
  }, 30_000);
});
