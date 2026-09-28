import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * End-to-end proof that the own-backend classification fix and the
 * declared-foldReturn-joinFields resolution fix hold TOGETHER against the
 * exact composite incident shape: an own-backend REST/JSON site with a
 * declared `submitEndpointPattern` and a declared `foldReturn.joinFields`
 * spec, whose archive also contains genuinely GraphQL-shaped third-party
 * traffic. Either regressing alone reproduces the incident: the
 * classification defect flips the whole flow to GraphQL (starving the
 * submit-pattern matcher and the REST fold resolver of the real captures),
 * and the join-field defect rejects the declared field and falls back to a
 * guessed structural one, so this test would fail on either fix regressing
 * even though each has its own focused unit test already.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.own-backend-composite-fixture.example.com";
const THIRD_PARTY_HOST = "chat.third-party-gql-widget-composite.example.net";

function restCapture(overrides: {
  phase: string;
  method: string;
  url: string;
  status: number;
  requestPostData?: string | null;
  responseBody: unknown;
  timestamp: string;
}) {
  return {
    timestamp: overrides.timestamp,
    phase: overrides.phase,
    method: overrides.method,
    url: overrides.url,
    status: overrides.status,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: overrides.requestPostData ?? null,
    responseHeaders: {},
    responseBody: overrides.responseBody,
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

function graphqlCapture(overrides: {
  phase: string;
  url: string;
  operationName: string;
  query: string;
  responseBody: unknown;
  timestamp: string;
}) {
  return {
    timestamp: overrides.timestamp,
    phase: overrides.phase,
    method: "POST",
    url: overrides.url,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify({
      operationName: overrides.operationName,
      query: overrides.query,
    }),
    responseHeaders: {},
    responseBody: overrides.responseBody,
    operationName: overrides.operationName,
    query: overrides.query,
    variables: null,
    decodedParams: null,
  };
}

/**
 * A run dir with: (a) own-backend REST captures for a search step and a
 * submit step whose URL matches the declared `submitEndpointPattern`, (b) a
 * distinct own-backend drill endpoint the declared `foldReturn.joinFields`
 * resolves against, and (c) real GraphQL POST captures (populated
 * operationName/query) on a distinct third-party host that fire first and
 * outnumber the own-backend captures, matching the incident's chat-widget-
 * alongside-REST-backend shape.
 */
function writeRunDir(root: string): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));

  const thirdPartyGraphQL = graphqlCapture({
    phase: "home",
    url: `https://${THIRD_PARTY_HOST}/graphql`,
    operationName: "TrackWidgetEvent",
    query: "mutation TrackWidgetEvent($event: String!) { trackEvent(event: $event) { ok } }",
    responseBody: { data: { trackEvent: { ok: true } } },
    timestamp: "2026-08-18T10:23:00.000Z",
  });
  for (let i = 0; i < 5; i++) {
    writeFileSync(
      join(root, "graphql", `000-home-widget-${String(i).padStart(2, "0")}.json`),
      JSON.stringify(thirdPartyGraphQL)
    );
  }

  const searchCapture = restCapture({
    phase: "search-listings",
    method: "POST",
    url: `https://${OWN_BACKEND_HOST}/api/listings/search`,
    status: 200,
    requestPostData: JSON.stringify({ query: "units" }),
    responseBody: { listings: [{ listingId: "L1", name: "Unit A" }] },
    timestamp: "2026-08-18T10:23:02.000Z",
  });
  writeFileSync(
    join(root, "graphql", "100-search-listings-action.json"),
    JSON.stringify(searchCapture)
  );

  const submitCapture = restCapture({
    phase: "apply-to-listing",
    method: "POST",
    url: `https://${OWN_BACKEND_HOST}/api/listings/apply-listing`,
    status: 200,
    requestPostData: JSON.stringify({ listingId: "L1" }),
    responseBody: { status: "ok" },
    timestamp: "2026-08-18T10:23:03.000Z",
  });
  writeFileSync(
    join(root, "graphql", "200-apply-listing-action.json"),
    JSON.stringify(submitCapture)
  );

  const foldTargetCapture = restCapture({
    phase: "listing-details",
    method: "GET",
    url: `https://${OWN_BACKEND_HOST}/api/listings/listing-details?listingId=L1`,
    status: 200,
    responseBody: { details: { items: [{ listingId: "L1", price: 99 }] } },
    timestamp: "2026-08-18T10:23:04.000Z",
  });
  writeFileSync(
    join(root, "graphql", "300-listing-details-action.json"),
    JSON.stringify(foldTargetCapture)
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

describe("recon-generate CLI — composite own-backend REST classification, declared submitEndpointPattern, and declared foldReturn joinFields resolve together against third-party GraphQL noise", () => {
  it("classifies as REST, matches the declared submit pattern, resolves the declared join field, and emits a compiling contract", () => {
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }

    workDir = mkdtempSync(join(tmpdir(), "barnacle-composite-misclassification-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `composite-misclassification-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "search listings" }, { step: "apply to listing", submitStep: true }],
        submitEndpointPattern: "apply-listing",
        ownBackendHostnames: [OWN_BACKEND_HOST],
        foldReturn: {
          endpointPattern: "listing-details",
          resultsPath: "listings",
          drillResultsPath: "details.items",
          joinFields: ["listingId"],
        },
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    // The composite incident's classification half: the third-party GraphQL
    // widget traffic must never flip the own-backend REST flow to GraphQL.
    expect(result.stdout).toContain(`generating plugin for ${siteId} (submission flow,`);
    expect(result.stdout).not.toContain(`generating plugin for ${siteId} (GraphQL,`);
    expect(result.stdout).not.toContain("no fold plan resolved");
    expect(result.stdout).not.toMatch(/"msg":"[^"]*GraphQL/);

    const contractPath = join(siteOutDir, "contract.ts");
    const contract = readFileSync(contractPath, "utf8");

    expect(contract).not.toContain("createGraphqlClient");
    expect(contract).not.toContain(THIRD_PARTY_HOST);
    expect(contract).not.toContain("TrackWidgetEvent");

    // The declared submitEndpointPattern's own-backend match survives —
    // proof the submit-pattern capture count is non-zero.
    expect(contract).toContain("apply-listing");

    // The composite incident's fold half: the declared foldReturn.joinFields
    // entry resolves and reaches the emission, not a guessed structural
    // field.
    expect(contract).toContain("listingId");
    expect(contract).toContain("listing-details");

    tsconfigPath = join(
      REPO_ROOT,
      `tsconfig.recon-composite-misclassification.${process.pid}.json`
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
