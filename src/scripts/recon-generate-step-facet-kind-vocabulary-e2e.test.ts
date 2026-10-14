import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * A payloadField declared on click steps must reach every captured request
 * element carrying its value in a `<literal>;<key>=<kind>` vocabulary, keeping
 * the kind suffix and the captured casing, and never freezing the array.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.step-facet-kind-vocabulary-fixture.example.com";

function fixtureCaptures(): Capture[] {
  return [
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/catalog/browse/`,
      requestPostData: JSON.stringify({ sort: "relevance" }),
      responseBody: { ok: true },
      timestamp: "2026-04-01T00:00:00.000Z",
    }),
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/catalog/filter-results/`,
      requestPostData: JSON.stringify({
        sort: "relevance",
        filters: [
          "BAHAMAS;filterType=destination",
          "4;filterType=night",
          "summer;filterType=theme",
        ],
      }),
      responseBody: { ok: true },
      timestamp: "2026-04-01T00:00:01.000Z",
    }),
  ];
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

/**
 * Body template of every `httpClient(...)` call. Split on the emitter's stable
 * idiom rather than a backtick-free regex, because a spliced array renders as
 * `${JSON.stringify([`${payload.X}...`])}` and nests backticks.
 */
function extractBodyBlocks(contract: string): string[] {
  return contract
    .split("httpClient(`")
    .slice(1)
    .map((chunk) => chunk.slice(chunk.indexOf("body: `") + "body: `".length))
    .map((chunk) => chunk.slice(0, chunk.indexOf("`,\n      schema:")));
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate CLI — step facets in a kind-suffixed array vocabulary", () => {
  it("emits a conditional spread per declared facet and no fully literal array", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-step-facet-kind-vocabulary-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `step-facet-kind-vocabulary-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "browse catalog" },
          {
            step: "click the 'Bahamas' option",
            payloadField: "destination",
            optional: true,
          },
          { step: "click the '4' option", payloadField: "nights", optional: true },
          { step: "apply filters", submitStep: true },
        ],
        submitEndpointPattern: "catalog/filter-results",
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
    expect(contract).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source
      "...(payload.destination ? [`${String(payload.destination).toUpperCase()};filterType=destination`] : [])"
    );
    expect(contract).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source
      "...(payload.nights ? [`${payload.nights};filterType=night`] : [])"
    );
    expect(contract).not.toContain('"BAHAMAS;filterType=destination"');
    expect(contract).not.toContain('"4;filterType=night"');
  });
});
