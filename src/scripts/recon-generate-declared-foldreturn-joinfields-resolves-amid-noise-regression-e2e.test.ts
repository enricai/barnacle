import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * End-to-end proof through the real `recon-generate` CLI that a declared
 * `foldReturn.joinFields` resolves onto the real primary's own drill-down
 * — rather than a plausible, structurally-guessed alternate the SAME drill
 * response also exposes — when the archive also carries unrelated
 * GraphQL-shaped third-party noise. The drill endpoint is captured TWICE
 * (a plain lookup, then a "refresh" re-query) at the SAME endpoint
 * identity: the structural heuristic threads `code` from the primary
 * item's own field into the FIRST occurrence's URL path segment and
 * resolves its target there, while the declared `foldReturn.joinFields:
 * ["bookingRef"]` names a field the heuristic could never infer — it
 * threads through no request anywhere, only appearing in both drill
 * occurrences' RESPONSES — so `buildFoldPlanFromSpec` must resolve it
 * against a drill response and override the structural target's own
 * `code` guess in place. Mirrors the spawnSync-CLI fixture idiom of
 * recon-generate-fold-plan-primary-op-differs-from-emitted-primary-runtime-e2e.test.ts
 * and the fixture shape of
 * recon-generate-foldreturn-declared-joinfields-override-structural-heuristic-runtime-e2e.test.ts,
 * driven through the real CLI instead of `emitMultiStepExecuteHttp` directly.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

function restCapture(overrides: {
  timestamp: string;
  url: string;
  requestPostData?: string | null;
  responseBody: unknown;
}): unknown {
  return {
    timestamp: overrides.timestamp,
    phase: "action",
    method: "POST",
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

/**
 * Genuinely GraphQL-shaped third-party noise captures — a distinct host,
 * real `operationName`/`query` fields — so the declared fold's resolution
 * is proven to survive amid the same kind of archive noise this
 * incident's report combined with its own-backend REST traffic.
 */
function graphqlNoiseCapture(index: number): unknown {
  const query = "query trackImpression { impression { id } }";
  return {
    timestamp: `2026-02-01T00:00:1${index}Z`,
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

  // Primary: a reservation search whose item carries `code` — the field
  // the structural heuristic can thread into the drill URL — AND
  // `bookingRef`, the declared joinFields value the heuristic never sees
  // on any request, only on the drill responses below.
  writeFileSync(
    join(root, "graphql", "000-action-search.json"),
    JSON.stringify(
      restCapture({
        timestamp: "2026-02-01T00:00:00Z",
        url: "https://api.booking-fixture.example.com/reservations/search/",
        responseBody: { reservations: [{ code: "res-1", bookingRef: "bk-77" }] },
      })
    )
  );

  // Same endpoint identity captured TWICE: a plain lookup, then a
  // "refresh" re-query — both carry the real `bookingRef` AND the
  // structurally-guessed `code`, so the assertion below distinguishes
  // "declared field used" from "guessed field used" rather than both
  // being present coincidentally.
  writeFileSync(
    join(root, "graphql", "001-action-details-lookup.json"),
    JSON.stringify(
      restCapture({
        timestamp: "2026-02-01T00:00:01Z",
        url: "https://api.booking-fixture.example.com/reservations/res-1/details/",
        responseBody: { rows: [{ code: "res-1", bookingRef: "bk-77", price: 100 }] },
      })
    )
  );
  writeFileSync(
    join(root, "graphql", "002-action-details-refresh.json"),
    JSON.stringify(
      restCapture({
        timestamp: "2026-02-01T00:00:02Z",
        url: "https://api.booking-fixture.example.com/reservations/res-1/details/?refresh=true",
        responseBody: { rows: [{ code: "res-1", bookingRef: "bk-77", price: 150 }] },
      })
    )
  );

  for (let i = 0; i < 3; i++) {
    writeFileSync(
      join(root, "graphql", `900-action-gql-noise-${i}.json`),
      JSON.stringify(graphqlNoiseCapture(i))
    );
  }
}

function writeFlowFile(siteOutDir: string): void {
  mkdirSync(siteOutDir, { recursive: true });
  const flow: Record<string, unknown> = {
    steps: [{ step: "search reservations and check availability" }],
    foldReturn: {
      endpointPattern: "/reservations/res-1/details/",
      resultsPath: "reservations",
      drillResultsPath: "rows",
      joinFields: ["bookingRef"],
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

describe("recon-generate CLI — declared foldReturn joinFields resolves amid a plausible structural candidate and GraphQL noise", () => {
  it("keys the emitted fold/merge on the declared bookingRef field, never the structurally-guessed code field", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-foldreturn-declared-amid-noise-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `foldreturn-declared-amid-noise-test-run${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    writeFlowFile(siteOutDir);

    const result = run(runRoot, siteId);
    const out = `${result.stdout}\n${result.stderr}`;

    expect(result.status, out).toBe(0);
    expect(out).not.toContain("the declared spec resolved no fold plan");
    expect(out).not.toContain("only structurally-detected fold plans");

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contract).toContain('m["bookingRef"]');
    expect(contract).not.toContain('m["code"]');
  }, 30_000);
});
