import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Reproduces the full noisy-archive incident report at representative scale:
 * a large, noisy own-backend REST archive whose declared `submitEndpointPattern`
 * and declared `foldReturn.joinFields` must both resolve against the real
 * own-backend captures, one of which genuinely carries a body field literally
 * named `operationName`/`query` (populated the same way the live capture
 * pipeline populates those fields off ANY JSON request body — see
 * flow-runner.ts's `operationName`/`query` extraction, which reads those
 * field names off every POST body regardless of REST vs GraphQL shape), amid
 * real third-party GraphQL noise on a separate host. Regressing any one of
 * the three fixes this report bundled (own-backend classification,
 * declared-submitEndpointPattern resolution, declared-foldReturn.joinFields
 * resolution) reproduces a distinct symptom from the report, so this test
 * fails on any of them regressing even though each already has its own
 * narrower unit/e2e test.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.noisy-archive-composite-fixture.example.com";
const THIRD_PARTY_HOST = "widget.noisy-archive-composite-decoy.example.net";

/**
 * Mirrors flow-runner.ts's real extraction: `operationName`/`query` are
 * populated off ANY parsed JSON request body that happens to carry fields
 * with those names, regardless of whether the traffic is GraphQL. A REST
 * backend's own field named `query` (e.g. a search term) is captured the
 * same way as a real GraphQL query document.
 */
function restCapture(overrides: {
  method: string;
  url: string;
  requestPostData: string | null;
  responseBody: unknown;
  timestamp: string;
}): Capture {
  const parsed = overrides.requestPostData !== null ? JSON.parse(overrides.requestPostData) : null;
  const operationName =
    parsed && typeof parsed.operationName === "string" ? parsed.operationName : null;
  const query = parsed && typeof parsed.query === "string" ? parsed.query : null;
  return {
    timestamp: overrides.timestamp,
    phase: "action",
    method: overrides.method,
    url: overrides.url,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: overrides.requestPostData,
    responseHeaders: { "content-type": "application/json" },
    responseBody: overrides.responseBody,
    operationName,
    query,
    variables: parsed?.variables ?? null,
    decodedParams: parsed,
  };
}

function thirdPartyGraphQLCapture(index: number): Capture {
  const operationName = "TrackNoiseEvent";
  const query = "mutation TrackNoiseEvent($event: String!) { trackEvent(event: $event) { ok } }";
  return {
    timestamp: `2026-08-18T10:20:${String(index % 60).padStart(2, "0")}.000Z`,
    phase: "home",
    method: "POST",
    url: `https://${THIRD_PARTY_HOST}/graphql`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ operationName, query }),
    responseHeaders: { "content-type": "application/json" },
    responseBody: { data: { trackEvent: { ok: true } } },
    operationName,
    query,
    variables: null,
    decodedParams: null,
  };
}

/**
 * A run dir shaped like the report: a large volume of third-party GraphQL
 * noise (fires first, outnumbers the own-backend traffic), a search step
 * whose REST body coincidentally carries a `query`-named field with a
 * plain (non-GraphQL) string value, a submit step whose URL matches the
 * declared submitEndpointPattern amid own-backend noise reads, and a
 * distinct drill endpoint the declared foldReturn.joinFields resolves
 * against.
 */
function writeRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));

  let index = 0;
  const write = (capture: Capture, label: string): void => {
    writeFileSync(
      join(root, "graphql", `${String(index).padStart(4, "0")}-${label}.json`),
      JSON.stringify(capture)
    );
    index++;
  };

  // Third-party GraphQL widget noise — fires first, dwarfs the own-backend
  // traffic, matching the report's noise-vs-signal ratio.
  for (let i = 0; i < 60; i++) {
    write(thirdPartyGraphQLCapture(i), "noise-widget");
  }

  // Own-backend REST search step whose body carries a coincidental
  // `query`-named field with an ordinary string value (not a GraphQL
  // document) and returns the single item the submit step below acts on.
  write(
    restCapture({
      method: "POST",
      url: `https://${OWN_BACKEND_HOST}/api/catalog/search`,
      requestPostData: JSON.stringify({
        query: "catalog-term-0",
        operationName: "searchCatalog",
        page: 0,
      }),
      responseBody: { results: [{ itemId: "item-0", code: "c1" }] },
      timestamp: "2026-08-18T10:23:00.000Z",
    }),
    "search"
  );

  // Bulk own-backend read noise on a distinct endpoint — unrelated to the
  // declared submitEndpointPattern and foldReturn shape — to bulk out the
  // archive's noise-vs-signal ratio without contending for the primary
  // array or the join value.
  for (let i = 0; i < 20; i++) {
    write(
      restCapture({
        method: "GET",
        url: `https://${OWN_BACKEND_HOST}/api/catalog/categories`,
        requestPostData: null,
        responseBody: { categories: [`category-${i}`] },
        timestamp: `2026-08-18T10:23:${String(i + 1).padStart(2, "0")}.000Z`,
      }),
      "categories-noise"
    );
  }

  // The real own-backend submission — matches the declared
  // submitEndpointPattern amid the read noise above.
  write(
    restCapture({
      method: "POST",
      url: `https://${OWN_BACKEND_HOST}/api/catalog/apply-item`,
      requestPostData: JSON.stringify({ itemId: "item-0" }),
      responseBody: { status: "ok" },
      timestamp: "2026-08-18T10:23:40.000Z",
    }),
    "submit"
  );

  // The declared foldReturn drill-down target — threads the primary item's
  // `code` field (not the declared join field) through its URL, so a
  // structural guess would infer `code` as the join key. The declared
  // `joinFields: ["itemId"]` names a field that only ever appears in the
  // primary/drill RESPONSE bodies, not in any threaded request, forcing
  // `buildFoldPlanFromSpec`'s response-only resolution path — exactly the
  // path that must win over the structural guess.
  write(
    restCapture({
      method: "GET",
      url: `https://${OWN_BACKEND_HOST}/api/catalog/item-details/c1`,
      requestPostData: null,
      responseBody: { details: { items: [{ itemId: "item-0", code: "c1", price: 42 }] } },
      timestamp: "2026-08-18T10:23:41.000Z",
    }),
    "item-details"
  );
}

let workDir: string | null = null;
let siteOutDir: string | null = null;
let tsconfigPath: string | null = null;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  if (tsconfigPath) rmSync(tsconfigPath, { force: true });
  workDir = null;
  siteOutDir = null;
  tsconfigPath = null;
});

describe("recon-generate CLI — noisy archive composite incident: REST classification, declared submitEndpointPattern, and declared foldReturn.joinFields hold together at scale", () => {
  it("classifies as REST, matches the declared submit pattern, resolves the declared join field, and emits a compiling contract", () => {
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }

    workDir = mkdtempSync(join(tmpdir(), "barnacle-noisy-archive-composite-incident-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `noisy-archive-composite-incident-e2e-test-${process.pid}`;
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

    // Classification half: the coincidental `query`-named REST body field
    // and the third-party GraphQL noise must never flip the own-backend
    // flow to GraphQL.
    expect(result.stdout).toContain(`generating plugin for ${siteId} (submission flow,`);
    expect(result.stdout).not.toContain(`generating plugin for ${siteId} (GraphQL,`);

    // Declared submitEndpointPattern half: no spurious 0-capture(s)
    // disagreement against the (correctly REST) heuristic baseline.
    expect(combinedOutput).not.toContain("(0 capture(s)) disagrees with the unfiltered heuristic");

    // Declared foldReturn.joinFields half: the declared spec resolves, not
    // a guessed structural fallback.
    expect(combinedOutput).not.toContain("no fold plan resolved");
    expect(combinedOutput).not.toContain("only structurally-detected fold plans");

    const contractPath = join(siteOutDir, "contract.ts");
    const contract = readFileSync(contractPath, "utf8");

    expect(contract).not.toContain("createGraphqlClient");
    expect(contract).not.toContain(THIRD_PARTY_HOST);
    expect(contract).not.toContain("TrackNoiseEvent");
    expect(contract).toContain("apply-item");
    expect(contract).toContain("itemId");
    expect(contract).toContain("item-details");

    tsconfigPath = join(REPO_ROOT, `tsconfig.recon-noisy-archive-composite.${process.pid}.json`);
    writeFileSync(
      tsconfigPath,
      JSON.stringify({
        extends: "./tsconfig.json",
        compilerOptions: {
          noEmit: true,
          incremental: false,
          tsBuildInfoFile: null,
          paths: {
            "@/*": ["./src/*"],
            "@test/*": ["./test/*"],
            "@enricai/barnacle/*": ["./src/*"],
          },
        },
        include: [`src/sites/${siteId}/**/*.ts`],
      })
    );

    const check = spawnSync(TSC_BIN, ["-p", tsconfigPath, "--noEmit"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });

    const diagnostics = `${check.stdout}\n${check.stderr}`;
    const referencesEmittedFiles =
      diagnostics.includes("contract.ts") || diagnostics.includes("browser-flow.ts");
    expect(referencesEmittedFiles, diagnostics).toBe(false);
    expect(check.status, diagnostics).toBe(0);
  }, 60_000);
});
