import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Directly reproduces the report's symptom #2 against a correctly-scoped,
 * correctly-classified archive: a declared submitEndpointPattern with real
 * matching captures in the raw archive gets reported as "0 capture(s)" and
 * rejected in favor of the unfiltered heuristic sequence, even though the
 * dominant host's own submissions genuinely satisfy the pattern.
 *
 * This is deliberately NOT a retest of deriveBaseUrl's host-scoping (covered
 * by recon-generate-cross-registrable-domain-minority-host-does-not-anchor-
 * base-url-e2e) or of isGraphQL's classification vote (covered by
 * recon-generate.test.ts's own-backend REST anti-vote cases). Instead this
 * fixture combines both shapes at once -- a cross-registrable-domain
 * noise/redirect host, PLUS a small minority of genuinely-parsed GraphQL-
 * shaped captures on the dominant host's own registrable domain, PLUS a
 * dominant host whose real own-backend REST traffic includes zero-variance
 * repeat GETs (the shape the REST anti-vote rescue protects) -- to prove
 * that once scope and classification land correctly, generateFromCaptures's
 * `gql ? extractGraphQLActionSequence : extractActionSequence` dispatch
 * (recon-generate.ts) lands in the REST branch and that branch's submission
 * selection reflects the real, greppable match count against the declared
 * pattern rather than falling back into the "0 capture(s)" disagreement
 * path.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const DOMINANT_HOST = "api.inventory-fixture.example.org";
// A genuinely different registrable domain from DOMINANT_HOST, standing in
// for the report's unplanned mid-session redirect host -- noise that must
// never anchor baseUrl or dilute the submission-selection vote.
const REDIRECT_HOST = "accounts.inventory-fixture-auth.example.net";

const ITEM_IDS = Array.from({ length: 18 }, (_, i) => `sku-${i}`);

function restCapture(overrides: {
  method: string;
  url: string;
  requestPostData: string | null;
  responseBody: unknown;
  timestamp: string;
}): Capture {
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
    operationName: null,
    query: null,
    variables: null,
    decodedParams:
      overrides.requestPostData !== null ? JSON.parse(overrides.requestPostData) : null,
  };
}

function graphqlLookingCapture(overrides: {
  url: string;
  query: string;
  responseBody: unknown;
  timestamp: string;
}): Capture {
  return {
    timestamp: overrides.timestamp,
    phase: "action",
    method: "POST",
    url: overrides.url,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({ query: overrides.query }),
    responseHeaders: { "content-type": "application/json" },
    responseBody: overrides.responseBody,
    operationName: null,
    query: overrides.query,
    variables: null,
    decodedParams: { query: overrides.query },
  };
}

/**
 * Reproduces the report archive's shape at small scale: a dominant REST host
 * with (a) real submissions genuinely matching the declared
 * submitEndpointPattern in large enough number to be unambiguous, (b) bulk
 * zero-variance repeat GET traffic (a static category list), and (c) a
 * minority handful of genuinely-parsed GraphQL-shaped documents on its own
 * registrable domain -- none of which should be enough to flip
 * classification given the rescued REST anti-vote. A cross-registrable-
 * domain redirect host contributes pure noise, standing in for the report's
 * login-page detour.
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

  // Redirect/noise host, arriving first purely due to async completion
  // timing, standing in for the report's mid-session login-domain detour.
  for (let i = 0; i < 6; i++) {
    write(
      restCapture({
        method: "GET",
        url: `https://${REDIRECT_HOST}/sso/session`,
        requestPostData: null,
        responseBody: { authenticated: true },
        timestamp: `2026-09-01T09:00:0${i}.000Z`,
      }),
      "redirect-host-noise"
    );
  }

  // The dominant host's listing capture, seeding the item ids the declared
  // foldReturn.resultsPath resolves against.
  write(
    restCapture({
      method: "POST",
      url: `https://${DOMINANT_HOST}/api/inventory/search`,
      requestPostData: JSON.stringify({ page: 1 }),
      responseBody: { results: ITEM_IDS.map((itemId) => ({ itemId })) },
      timestamp: "2026-09-01T09:01:00.000Z",
    }),
    "list-items"
  );

  // Bulk own-backend zero-variance repeat noise on the dominant host -- the
  // same response every call, the shape the rescued REST anti-vote keeps as
  // genuine own-backend evidence instead of erasing to zero.
  for (let i = 0; i < 25; i++) {
    write(
      restCapture({
        method: "GET",
        url: `https://${DOMINANT_HOST}/api/inventory/categories`,
        requestPostData: null,
        responseBody: { categories: ["tools", "parts", "kits"] },
        timestamp: `2026-09-01T09:02:${String(i).padStart(2, "0")}.000Z`,
      }),
      "categories-zero-variance"
    );
  }

  // A single genuinely-parsed GraphQL-shaped document on the dominant host's
  // own registrable domain -- real signal, but too small a share of the
  // host-scoped voting pool (which also carries this host's own-backend REST
  // anti-vote evidence below) to flip classification away from REST.
  write(
    graphqlLookingCapture({
      url: `https://${DOMINANT_HOST}/graphql`,
      query: `query RelatedItems { relatedItems(id: "sku-0") { id } }`,
      responseBody: { data: { relatedItems: [{ id: "sku-0" }] } },
      timestamp: "2026-09-01T09:03:00.000Z",
    }),
    "graphql-minority"
  );

  // Genuine submissions matching the declared submitEndpointPattern -- 18 of
  // them, mirroring the report's "16 captures matching ... 19 matching ..."
  // greppable real match counts that a correct run must surface, not
  // collapse to "0 capture(s)".
  ITEM_IDS.forEach((itemId, i) => {
    write(
      restCapture({
        method: "POST",
        url: `https://${DOMINANT_HOST}/api/inventory/reserve`,
        requestPostData: JSON.stringify({ itemId }),
        // Every leaf must trace back to the request's own itemId -- a
        // response carrying a literal field no request ever supplied (e.g.
        // a constant "status" string) reads as unexplained, freely-varying
        // noise once the same-endpoint group is dense, and gets excluded
        // as a zero-variance repeat despite being a real submission.
        responseBody: { itemId },
        timestamp: `2026-09-01T09:04:${String(i).padStart(2, "0")}.000Z`,
      }),
      `reserve-${itemId}`
    );
  });

  // Declared foldReturn drill target.
  write(
    restCapture({
      method: "GET",
      url: `https://${DOMINANT_HOST}/api/inventory/detail/sku-4`,
      requestPostData: null,
      responseBody: {
        details: { items: [{ itemId: "sku-4", warehouseCode: "wh-4", quantity: 7 }] },
      },
      timestamp: "2026-09-01T09:05:00.000Z",
    }),
    "listing-detail"
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

describe("recon-generate CLI — declared submitEndpointPattern resolves against its real matching captures once host scope and REST/GraphQL classification are both correct", () => {
  it("classifies the dominant host as REST, dispatches to extractActionSequence, and surfaces the real submission match count instead of '0 capture(s)'", () => {
    if (!existsSync(TSX_BIN)) {
      throw new Error("tsx not installed — cannot run the real CLI");
    }
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }

    workDir = mkdtempSync(
      join(tmpdir(), "barnacle-declared-submit-pattern-resolves-after-rest-classification-")
    );
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `declared-submit-pattern-resolves-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);
    mkdirSync(siteOutDir, { recursive: true });
    // Deliberately NO `ownBackendHostnames` field, exercising the same
    // undeclared-hosts scope resolution the report's real flow used.
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "check inventory" }, { step: "reserve item", submitStep: true }],
        submitEndpointPattern: "inventory/reserve",
        requireSubmitEndpointMatch: true,
        foldReturn: {
          endpointPattern: "inventory/detail",
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

    // Classification: the dominant host's minority GraphQL-shaped traffic
    // and zero-variance repeat REST traffic must never flip this to GraphQL.
    expect(result.stdout).not.toContain(`generating plugin for ${siteId} (GraphQL,`);
    expect(result.stdout).toContain(`generating plugin for ${siteId} (submission flow,`);

    // The regression proper: the declared pattern's real 18 matching
    // captures must be surfaced, never collapsed to "0 capture(s)", and
    // requireSubmitEndpointMatch must be satisfied by genuine data, not by
    // falling back onto the disagreement path.
    expect(combinedOutput).not.toContain("0 capture(s)");
    expect(combinedOutput).not.toContain("disagrees with the unfiltered heuristic action sequence");
    expect(combinedOutput).not.toContain("only structurally-detected fold plans");
    expect(combinedOutput).not.toContain("declared joinFields were not applied");

    const contractPath = join(siteOutDir, "contract.ts");
    const contract = readFileSync(contractPath, "utf8");

    // The submission-selection/fold-dispatch consumer site: the declared
    // pattern's own endpoint and join field must reach the emitted contract,
    // proving extractActionSequence (the REST branch) was reached and
    // matched the declared pattern rather than extractGraphQLActionSequence.
    expect(contract).toContain(DOMINANT_HOST);
    expect(contract).not.toContain(REDIRECT_HOST);
    expect(contract).toContain("inventory/reserve");
    expect(contract).toContain("itemId");
    expect(contract).toContain("inventory/detail");

    // The emitted contract must compile cleanly.
    tsconfigPath = join(
      REPO_ROOT,
      `tsconfig.recon-declared-submit-pattern-resolves.${process.pid}.json`
    );
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
