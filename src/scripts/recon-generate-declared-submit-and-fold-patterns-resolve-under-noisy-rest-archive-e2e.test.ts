import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Acceptance coverage for the reported cascade at representative scale: a
 * generic-domain, own-backend REST archive where (1) classification must
 * stay REST despite a coincidental query-shaped body field and a same-domain
 * redirect-style noise capture, (2) the declared submitEndpointPattern's
 * real, plentiful matching captures must be counted rather than reported as
 * "0 capture(s)", and (3) the declared foldReturn.joinFields must resolve
 * against the real response bodies rather than falling back to a guessed
 * structural join key. Mirrors the composite-incident-regression-e2e
 * pattern in recon-generate-noisy-archive-composite-incident-regression-e2e.test.ts,
 * scaled up on the submit-pattern-match side per
 * recon-generate-noisy-archive-submit-pattern-match-not-undercounted-e2e.test.ts.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.declared-submit-fold-archive-fixture.example.com";

const GENUINE_SUBMIT_COUNT = 24;

function fixtureCaptures(): Capture[] {
  // The list step: an ordinary own-backend REST call whose body carries a
  // field literally named `query` (holding a plain search-term string, not a
  // GraphQL document) — the coincidental shape flow-runner.ts's real capture
  // pipeline produces off any JSON POST body.
  const searchStep = buildCapture({
    url: `https://${OWN_BACKEND_HOST}/api/catalog/search`,
    requestPostData: JSON.stringify({ query: "catalog-term", page: 0 }),
    responseBody: {
      results: Array.from({ length: GENUINE_SUBMIT_COUNT }, (_unused, index) => ({
        itemId: `item-${index}`,
        code: `c${index}`,
      })),
    },
    timestamp: "2026-08-18T10:00:00.000Z",
  });

  // The real, plentiful own-backend submissions — every one matches the
  // declared submitEndpointPattern, so the reported count must be the full
  // genuine total, not "0 capture(s)".
  const genuineSubmits = Array.from({ length: GENUINE_SUBMIT_COUNT }, (_unused, index) =>
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/api/catalog/apply-item`,
      requestPostData: JSON.stringify({ itemId: `item-${index}` }),
      responseBody: { status: "ok" },
      timestamp: `2026-08-18T10:01:${String(index).padStart(2, "0")}.000Z`,
    })
  );

  // A same-domain redirect-style noise capture: a 302 own-backend response
  // with no meaningful body, unrelated to the declared submit pattern or the
  // fold target, mixed in to bulk out the archive's noise-vs-signal ratio.
  const redirectNoise = buildCapture({
    method: "GET",
    url: `https://${OWN_BACKEND_HOST}/api/catalog/`,
    requestPostData: null,
    responseBody: null,
    responseHeaders: { "content-type": "text/html", location: `https://${OWN_BACKEND_HOST}/api/catalog/home` },
    timestamp: "2026-08-18T10:02:00.000Z",
  });

  // The declared foldReturn drill-down target: threads the primary item's
  // `code` field (not the declared join field) through its URL, so a
  // structural guess would infer `code` as the join key. The declared
  // `joinFields: ["itemId"]` names a field that only ever appears in the
  // primary/drill RESPONSE bodies, forcing buildFoldPlanFromSpec's
  // response-only resolution path to win over the structural guess.
  const itemDetails = buildCapture({
    method: "GET",
    url: `https://${OWN_BACKEND_HOST}/api/catalog/item-details/c0`,
    requestPostData: null,
    responseBody: { details: { items: [{ itemId: "item-0", code: "c0", price: 42 }] } },
    timestamp: "2026-08-18T10:02:01.000Z",
  });

  return [searchStep, ...genuineSubmits, redirectNoise, itemDetails];
}

function writeRunDir(root: string, captures: Capture[]): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));
  captures.forEach((capture, index) => {
    writeFileSync(
      join(root, "graphql", `${String(index).padStart(4, "0")}-capture.json`),
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

describe("recon-generate CLI — declared submitEndpointPattern and declared foldReturn.joinFields resolve under a noisy REST archive", () => {
  it("classifies as REST, counts the real declared-pattern matches, and resolves the declared join field", () => {
    if (!existsSync(TSX_BIN)) {
      throw new Error("tsx not installed — cannot run the real CLI");
    }

    workDir = mkdtempSync(join(tmpdir(), "barnacle-declared-submit-and-fold-patterns-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `declared-submit-and-fold-patterns-e2e-test${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "search catalog" }, { step: "apply to item", submitStep: true }],
        submitEndpointPattern: "apply-item",
        requireSubmitEndpointMatch: true,
        ownBackendHostnames: [OWN_BACKEND_HOST],
        foldReturn: {
          endpointPattern: "item-details",
          resultsPath: "results",
          drillResultsPath: "details.items",
          joinFields: ["itemId"],
        },
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    expect(result.status, combinedOutput).toBe(0);

    // Classification: the coincidental `query`-named REST body field and the
    // same-domain redirect-style noise must never flip the flow to GraphQL.
    expect(result.stdout).toContain(`generating plugin for ${siteId} (submission flow,`);
    expect(result.stdout).not.toContain(`generating plugin for ${siteId} (GraphQL,`);

    // Declared submitEndpointPattern: the real, plentiful matches are
    // counted — never reported as a spurious 0-capture(s) disagreement.
    expect(combinedOutput).not.toContain("(0 capture(s)) disagrees with the unfiltered heuristic");
    expect(combinedOutput).not.toContain(
      `declared submitEndpointPattern/submitBodyPattern (0 capture(s))`
    );

    // Declared foldReturn.joinFields: the declared spec resolves, not a
    // guessed structural fallback.
    expect(combinedOutput).not.toContain("no fold plan resolved");
    expect(combinedOutput).not.toContain("only structurally-detected fold plans");

    const contractPath = join(siteOutDir, "contract.ts");
    const contract = readFileSync(contractPath, "utf8");

    expect(contract).not.toContain("createGraphqlClient");
    expect(contract).toContain("apply-item");
    expect(contract).toContain("itemId");
    expect(contract).toContain("item-details");
  }, 60_000);
});
