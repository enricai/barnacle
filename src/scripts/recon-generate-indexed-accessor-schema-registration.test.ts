import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins that an indexed accessor emitted into a request body
 * (`payload.sorts["0"]!.criteria`) always has a structured array schema,
 * whichever captured body or call site carries the field first.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");
const HOST = "www.indexed-accessor-schema-registration-fixture.example.com";

function fixtureCaptures(): Capture[] {
  const lead = buildCapture({
    url: `https://${HOST}/search/lookup/`,
    requestPostData: JSON.stringify({ destination: "Lisbon-Portugal" }),
    responseBody: { ok: true },
    timestamp: "2026-04-01T00:00:01.000Z",
  });
  const list = buildCapture({
    url: `https://${HOST}/search/results/`,
    requestPostData: JSON.stringify({
      sorts: [
        { criteria: "cheapest-first", order: "ASC", region: "MI" },
        { criteria: "dest-hash-facet-4412;sourceId=urlFriendlyId", order: "DESC", region: "MI" },
      ],
    }),
    responseBody: { ok: true },
    timestamp: "2026-04-01T00:00:00.000Z",
  });
  const submit = buildCapture({
    url: `https://${HOST}/search/apply-sort/`,
    requestPostData: JSON.stringify({
      sorts: [
        { criteria: "cheapest-first", order: "ASC", region: "MI" },
        { criteria: "dest-hash-facet-4412;sourceId=urlFriendlyId", order: "DESC", region: "MI" },
      ],
      page: 1,
    }),
    responseBody: { ok: true },
    timestamp: "2026-04-01T00:00:02.000Z",
  });
  return [list, lead, submit];
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate CLI — indexed accessor schema registration", () => {
  it("declares sorts as an array of objects wherever an indexed accessor is emitted", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-indexed-accessor-"));
    const runRoot = join(workDir, "run");
    mkdirSync(join(runRoot, "graphql"), { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));
    fixtureCaptures().forEach((capture, index) => {
      writeFileSync(
        join(runRoot, "graphql", `${String(index).padStart(3, "0")}-capture.json`),
        JSON.stringify(capture)
      );
    });
    const siteId = `indexed-accessor-schema-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "browse results" },
          {
            step: "navigate with destination",
            navigateTo: `https://${HOST}/#/search/dest-hash-facet-4412`,
            payloadField: "DestinationFacet",
          },
          { step: "look up" },
          { step: "apply sort", submitStep: true },
        ],
        submitEndpointPattern: "search/apply-sort",
        requireSubmitEndpointMatch: true,
        ownBackendHostnames: [HOST],
      })
    );
    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    const accessors = contract.match(/payload\.\w+\["\d+"\]/g) ?? [];
    expect(contract).toContain(`"sorts":[{"criteria":"${"$"}{payload.sorts["0"]!.criteria}"`);
    expect(accessors.length).toBeGreaterThan(0);
    for (const accessor of new Set(accessors)) {
      const field = accessor.slice("payload.".length).replace(/\[.*$/, "");
      expect(contract).toMatch(new RegExp(`\\n\\s*${field}:[^\\n]*z\\.array\\(z\\.object\\(`));
    }
    expect(contract).toMatch(/\n\s*sorts:[^\n]*z\.array\(z\.object\(/);
  }, 60_000);
});
