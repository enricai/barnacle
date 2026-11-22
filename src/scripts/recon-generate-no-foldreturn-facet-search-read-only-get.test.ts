import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifySubmissionFlow } from "@/scripts/recon-generate";
import { RECON_GENERATE_CWD } from "@/scripts/recon-generate-cwd.test-helper";
import { buildStep } from "@/scripts/recon-generate-multicall-fixture";

describe("classifySubmissionFlow — GET facet search without foldReturn", () => {
  it("is false for a read-only GET flow", () => {
    expect(
      classifySubmissionFlow({
        noReplayableActionFlow: false,
        isReadOnlyGetFlow: true,
        actionStepCount: 4,
        gql: false,
        actionCaptureMethods: ["GET", "GET", "GET", "GET"],
        graphqlActionSequenceHasMutation: false,
      })
    ).toBe(false);
  });
});

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");
const HOST = "api.example.com";

/** A one-off POST on a path the declared submit pattern does not select, whose
 * response no later request consumes — page chrome, not a step of the flow. */
function incidentalPost(i: number, path: string, response: unknown) {
  return buildStep(`p${i}`, {
    url: `https://${HOST}${path}`,
    requestPostData: JSON.stringify({ event: `e${i}` }),
    method: "POST",
    timestamp: `2026-11-02T11:59:0${i}.000Z`,
    responseBody: response,
  }).capture;
}

function facetSearchCaptures() {
  const facets = [
    "qty=2&region=C&pageNumber=1",
    "qty=3&region=C&pageNumber=1",
    "qty=3&region=A&pageNumber=1",
    "qty=3&region=A&brand=AA&pageNumber=1",
    // Report's literal: facet values collide with the primary's own item fields.
    "qty=3&region=A&shipcode=CB&port=MIA&durdays=7&pageNumber=1",
  ];
  return facets.map(
    (query, i) =>
      buildStep(`r${i}`, {
        url: `https://${HOST}/catalog/search?${query}`,
        requestPostData: null,
        method: "GET",
        timestamp: `2026-11-02T12:00:0${i + 1}.000Z`,
        responseBody: {
          results: {
            items: [
              {
                id: "I1",
                brandCode: "AA",
                shipCode: "CB",
                port: "MIA",
                durdays: 7,
                size: 7,
                imageUrl: "https://img.example.com/1.png",
              },
              { id: "I2", brandCode: "BB", size: 5, imageUrl: "https://img.example.com/2.png" },
            ],
          },
        },
      }).capture
  );
}

let workDir: string | null = null;
let siteOutDir: string | null = null;
afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

const INCIDENTAL_POST_SCENARIOS: Array<[string, () => unknown[]]> = [
  ["no incidental POST", () => []],
  [
    "an analytics POST fired before the facet searches",
    () => [incidentalPost(1, "/analytics/collect", { ok: true, id: 1 })],
  ],
  [
    "several incidental POSTs on other paths",
    () => [
      incidentalPost(1, "/analytics/collect", { ok: true, id: 1 }),
      incidentalPost(2, "/telemetry/log", { logged: "x" }),
      incidentalPost(3, "/consent/save", { saved: 2 }),
    ],
  ],
];

describe.each(INCIDENTAL_POST_SCENARIOS)(
  "recon-generate CLI — classified read-only GET facet search with no declared foldReturn (%s)",
  (_name, extraCaptures) => {
    it("generates a single-endpoint read plugin: no self-fold, no response-URL abort", () => {
      workDir = mkdtempSync(join(tmpdir(), "no-foldreturn-facet-ro-get-"));
      const runRoot = join(workDir, "run");
      for (const d of ["graphql", "replays", "aux"])
        mkdirSync(join(runRoot, d), { recursive: true });
      writeFileSync(join(runRoot, "replays", "rate-limit.json"), "[]");
      for (const [i, c] of [...extraCaptures(), ...facetSearchCaptures()].entries()) {
        writeFileSync(
          join(runRoot, "graphql", `${String(i).padStart(3, "0")}-capture.json`),
          JSON.stringify(c)
        );
      }
      const siteId = `no-foldreturn-facet-ro-get-test-${process.pid}`;
      siteOutDir = join(RECON_GENERATE_CWD, "src", "sites", siteId);
      mkdirSync(siteOutDir, { recursive: true });
      writeFileSync(
        join(siteOutDir, "recon-flow.json"),
        JSON.stringify({
          steps: [{ step: "search the catalog" }],
          submitEndpointPattern: "catalog/search",
          ownBackendHostnames: [HOST],
        })
      );
      const result = spawnSync(
        TSX_BIN,
        [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
        { cwd: RECON_GENERATE_CWD, encoding: "utf8" }
      );
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.status, output).toBe(0);
      const contract = readFileSync(
        join(RECON_GENERATE_CWD, "src", "sites", siteId, "contract.ts"),
        "utf8"
      );
      expect(output).toContain("single-endpoint REST");
      expect(output).not.toMatch(/unreferenced|frozen|fold plan/i);
      // One GET, no multi-step chain / per-item drill loop.
      expect(contract).toContain('method: "GET"');
      expect(contract.match(/catalog\/search/g)).toHaveLength(1);
      expect(output).not.toMatch(/multi-step/i);
      expect(contract).not.toMatch(/foldMatches|for \(const item of/);
      // The response schema's required-looking imageUrl is not a payload input.
      expect(contract).toContain("imageUrl");
      expect(contract).not.toContain("payload.imageUrl");
      // A literal-1 pageNumber facet stays a payload parameter defaulting to "1".
      expect(contract).toContain('String(payload.pageNumber ?? "1")');
      // Facet values equal to the primary's item fields stay payload inputs.
      for (const facet of ["shipcode", "port", "durdays"]) {
        expect(contract).toContain(`payload.${facet}`);
      }
    }, 90_000);
  }
);
