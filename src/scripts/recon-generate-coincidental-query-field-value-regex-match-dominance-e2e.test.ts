import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Exercises the reported failure shape directly: a REST search-term `query`
 * body-field VALUE that textually starts with `query <Word>` — satisfying
 * {@link import("@/recon/capture-filters").parsedOperationName}'s regex —
 * while remaining a small minority of the host-scoped voting pool
 * `isGraphQL()` (recon-generate.ts) counts over. Sibling coverage in this
 * file family (recon-generate-coincidental-query-field-minority-does-not-
 * flip-rest-classification-e2e.test.ts) already pins this same shape; this
 * file additionally pins the non-regression side — a flow genuinely
 * dominated by parsed GraphQL documents must still classify as GraphQL.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_HOST = "www.widget-marketplace-search-fixture.example.com";

function restCaptureWithQueryField(index: number, queryValue: string) {
  return {
    timestamp: `2026-08-18T10:23:0${index % 10}.000Z`,
    phase: "search",
    method: "POST",
    url: `https://${OWN_HOST}/api/search`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ query: queryValue }),
    responseHeaders: {},
    responseBody: { results: [{ id: `widget-${index}` }] },
    operationName: null,
    query: queryValue,
    variables: null,
    decodedParams: null,
  };
}

function graphqlCapture(index: number, operationName: string, query: string) {
  return {
    timestamp: `2026-08-18T10:24:0${index % 10}.000Z`,
    phase: "search",
    method: "POST",
    url: `https://${OWN_HOST}/graphql`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ operationName, query, variables: null }),
    responseHeaders: {},
    responseBody: { data: { searchWidgets: [{ id: `widget-${index}` }] } },
    operationName,
    query,
    variables: null,
    decodedParams: null,
  };
}

function writeFlowConfig(siteOutDir: string) {
  mkdirSync(siteOutDir, { recursive: true });
  writeFileSync(
    join(siteOutDir, "recon-flow.json"),
    JSON.stringify({
      steps: [{ step: "search widgets" }],
      ownBackendHostnames: [OWN_HOST],
    })
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

describe("isGraphQL() — coincidental query-field VALUE regex match vs. genuine GraphQL dominance", () => {
  it("classifies as REST when a minority REST search-term value textually matches the operation-name regex", () => {
    workDir = mkdtempSync(
      join(tmpdir(), "barnacle-coincidental-query-field-value-regex-rest-e2e-")
    );
    const runRoot = join(workDir, "run");
    mkdirSync(join(runRoot, "graphql"), { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));

    const searchTerms = ["lamp", "chair", "desk", "shelf", "mirror", "rug"];
    searchTerms.forEach((term, index) => {
      writeFileSync(
        join(runRoot, "graphql", `${String(index).padStart(3, "0")}-search.json`),
        JSON.stringify(restCaptureWithQueryField(index, term))
      );
    });
    // The reported shape: a plain search-term value that textually starts
    // with `query <Word>`, tripping parsedOperationName's regex without
    // being any kind of GraphQL document — an ordinary user search term,
    // not a client-authored operation.
    writeFileSync(
      join(runRoot, "graphql", "999-coincidental.json"),
      JSON.stringify(restCaptureWithQueryField(999, "query WidgetSearch for handmade lamps"))
    );

    const siteId = `coincidental-query-field-value-regex-rest-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    writeFlowConfig(siteOutDir);

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).not.toContain(`generating plugin for ${siteId} (GraphQL,`);
  }, 30_000);

  it("still classifies as GraphQL when parsed operation documents genuinely dominate the voting pool", () => {
    workDir = mkdtempSync(
      join(tmpdir(), "barnacle-coincidental-query-field-value-regex-graphql-e2e-")
    );
    const runRoot = join(workDir, "run");
    mkdirSync(join(runRoot, "graphql"), { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));

    const operationName = "searchWidgets";
    const query = "query searchWidgets($term: String) { searchWidgets(term: $term) { id name } }";
    for (let i = 0; i < 5; i++) {
      writeFileSync(
        join(runRoot, "graphql", `${String(i).padStart(3, "0")}-search.json`),
        JSON.stringify(graphqlCapture(i, operationName, query))
      );
    }

    const siteId = `coincidental-query-field-value-regex-graphql-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    writeFlowConfig(siteOutDir);

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(`generating plugin for ${siteId} (GraphQL,`);
  }, 30_000);
});
