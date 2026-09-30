import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Pins isGraphQL() (recon-generate.ts) against a single own-backend host
 * where every REST capture carries its own `query` body field (a common
 * search/filter parameter name), and exactly one of those field values
 * coincidentally starts with the literal text `query SomethingWeird` --
 * satisfying parsedOperationName's regex without being a real GraphQL
 * document. That one coincidental match must not outvote the surrounding
 * REST-majority traffic in the same host-scoped voting pool.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_HOST = "www.coincidental-query-field-fixture.example.com";

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
    responseBody: { results: [{ id: `item-${index}` }] },
    operationName: null,
    query: queryValue,
    variables: null,
    decodedParams: null,
  };
}

let workDir: string | null = null;
let siteOutDir: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("isGraphQL() -- coincidental query-field minority vs. REST-majority dominance", () => {
  it("classifies as REST when only one of many own-backend captures' query fields coincidentally satisfies parsedOperationName's regex", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-coincidental-query-field-minority-e2e-"));
    const runRoot = join(workDir, "run");
    mkdirSync(join(runRoot, "graphql"), { recursive: true });
    mkdirSync(join(runRoot, "replays"), { recursive: true });
    mkdirSync(join(runRoot, "aux"), { recursive: true });
    writeFileSync(join(runRoot, "replays", "rate-limit.json"), JSON.stringify([]));

    const searchTerms = ["widgets", "gadgets", "gizmos", "sprockets", "cogs", "wrenches"];
    searchTerms.forEach((term, index) => {
      writeFileSync(
        join(runRoot, "graphql", `${String(index).padStart(3, "0")}-search.json`),
        JSON.stringify(restCaptureWithQueryField(index, term))
      );
    });
    // The single coincidental capture: its `query` body field happens to
    // start with the GraphQL keyword+name shape parsedOperationName's
    // regex matches, but this is a plain REST search endpoint, not a
    // GraphQL client.
    writeFileSync(
      join(runRoot, "graphql", "999-coincidental.json"),
      JSON.stringify(restCaptureWithQueryField(999, "query SomethingWeird for parts"))
    );

    const siteId = `coincidental-query-field-minority-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({ ownBackendHostnames: [OWN_HOST], steps: [{ step: "search" }] })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).not.toContain(`generating plugin for ${siteId} (GraphQL,`);

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    expect(contract).not.toContain("SomethingWeird");
  }, 30_000);
});
