import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

function restCapture(overrides: {
  timestamp: string;
  method?: string;
  url: string;
  requestPostData?: string | null;
  responseBody: unknown;
}): unknown {
  return {
    timestamp: overrides.timestamp,
    phase: "action",
    method: overrides.method ?? "POST",
    url: overrides.url,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: overrides.requestPostData ?? null,
    responseHeaders: { "content-type": "application/json" },
    responseBody: overrides.responseBody,
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

function graphqlNoiseCapture(index: number): unknown {
  const query = "query trackImpression { impression { id } }";
  return {
    timestamp: `2026-02-01T00:01:${String(index).padStart(2, "0")}Z`,
    phase: "action",
    method: "POST",
    url: "https://telemetry.third-party-decoy.example.net/graphql",
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ query, variables: {} }),
    responseHeaders: { "content-type": "application/json" },
    responseBody: { impression: { id: `imp-${index}` } },
    operationName: "trackImpression",
    query,
    variables: {},
    decodedParams: null,
  };
}

function writeRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));

  // Primary: a nested products -> itineraries -> sailings search response.
  // Each sailing carries `sailingId` (the declared join field, never threaded
  // into any request) alongside `productId`/`itineraryId` (threaded into the
  // drill URL below, so the structural heuristic can guess a join off them).
  writeFileSync(
    join(root, "graphql", "000-action-search.json"),
    JSON.stringify(
      restCapture({
        timestamp: "2026-02-01T00:00:00Z",
        url: "https://api.cruise-fixture.example.com/products/search/",
        responseBody: {
          products: [
            {
              productId: "prod-1",
              itineraries: [
                {
                  itineraryId: "itin-1",
                  sailings: [{ sailingId: "sail-1" }],
                },
              ],
            },
          ],
        },
      })
    )
  );

  // Drill endpoint: URL threads productId/itineraryId (structural signal).
  // The response carries `sailingId` alongside `price` — the declared join
  // key is resolvable only via the drill's own RESPONSE, not any request.
  writeFileSync(
    join(root, "graphql", "001-action-availability.json"),
    JSON.stringify(
      restCapture({
        timestamp: "2026-02-01T00:00:01Z",
        method: "GET",
        url: "https://api.cruise-fixture.example.com/products/prod-1/itineraries/itin-1/availability/",
        requestPostData: null,
        responseBody: { availability: [{ sailingId: "sail-1", price: 199 }] },
      })
    )
  );

  // Archive noise: a large batch of unrelated GraphQL-shaped third-party
  // captures, plus a redirect-shaped batch of unrelated same-origin captures
  // that carry no products/itineraries/sailings shape at all — mirroring the
  // reported archive's real, unplanned mid-session redirect noise.
  for (let i = 0; i < 40; i++) {
    writeFileSync(
      join(root, "graphql", `900-action-gql-noise-${i}.json`),
      JSON.stringify(graphqlNoiseCapture(i))
    );
  }
  for (let i = 0; i < 40; i++) {
    writeFileSync(
      join(root, "graphql", `950-action-redirect-noise-${i}.json`),
      JSON.stringify(
        restCapture({
          timestamp: `2026-02-01T00:02:${String(i).padStart(2, "0")}Z`,
          method: "GET",
          url: `https://login.cruise-fixture.example.com/session/refresh/${i}/`,
          requestPostData: null,
          responseBody: { sessionToken: `tok-${i}` },
        })
      )
    );
  }
}

function writeFlowFile(siteOutDir: string): void {
  mkdirSync(siteOutDir, { recursive: true });
  const flow: Record<string, unknown> = {
    steps: [{ step: "search products and check sailing availability" }],
    foldReturn: {
      endpointPattern: "/itineraries/itin-1/availability/",
      resultsPath: "products.*.itineraries.*.sailings",
      drillResultsPath: "availability",
      joinFields: ["sailingId"],
    },
  };
  writeFileSync(join(siteOutDir, "recon-flow.json"), JSON.stringify(flow));
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

function run(runRoot: string, siteId: string): ReturnType<typeof spawnSync> {
  return spawnSync(
    TSX_BIN,
    [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
}

describe("recon-generate CLI — declared foldReturn joinFields on a nested wildcard resultsPath survives archive noise", () => {
  it("keys the emitted fold/merge on the declared sailingId field, never the structurally-guessed productId/itineraryId", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-foldreturn-nested-wildcard-noise-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `foldreturn-nested-wildcard-noise-test-run${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    writeFlowFile(siteOutDir);

    const result = run(runRoot, siteId);
    const out = `${result.stdout}\n${result.stderr}`;

    expect(result.status, out).toBe(0);
    expect(out).not.toContain("the declared spec resolved no fold plan");
    expect(out).not.toContain("only structurally-detected fold plans");

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contract).toContain('m["sailingId"]');
    expect(contract).not.toContain('m["productId"]');
    expect(contract).not.toContain('m["itineraryId"]');
  }, 30_000);
});
