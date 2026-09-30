import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Covers deriveBaseUrl's undeclared-hosts (no `ownBackendHostnames`) anchor
 * pick specifically for an all-REST archive (no GraphQL anywhere), which is
 * the one shape none of the sibling deriveBaseUrl tests exercise:
 *
 * - recon-generate-fallback-domain-declared-submit-and-fold-patterns-resolve-e2e
 *   and recon-generate.test.ts's "does not let a chatty host outvote the
 *   first non-noise capture" both put the minority host's captures AFTER the
 *   dominant host's first capture, so the existing "first non-noise capture
 *   wins" rule already picks the dominant host trivially.
 * - recon-generate.test.ts's "resolves to the dominant own-backend host when
 *   a same-company auth redirect ... sorts first" covers a minority host
 *   whose label matches AUTH_HOST_LABEL (`login.`), which isAuthRedirectCapture
 *   already excludes from the anchor pool regardless of registrable domain.
 *
 * Neither covers a minority host that (a) sorts first in array order, (b) is
 * on a genuinely different registrable domain from the dominant host, (c) has
 * fewer total captures than the dominant host, and (d) has a hostname label
 * that does NOT match AUTH_HOST_LABEL. deriveBaseUrl's sameDomainHasGraphql
 * gate only ever runs the cross-host dominance vote when the anchor's own
 * registrable-domain group contains GraphQL-shaped traffic; an all-REST
 * archive never sets that flag, so the dominance safeguard never runs at all
 * and the minority host that merely sorted first wins outright.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const DOMINANT_HOST = "www.orders-fixture.example.org";
// A genuinely different registrable domain from DOMINANT_HOST (not a
// subdomain), with a hostname label that does not match AUTH_HOST_LABEL, so
// this capture is neither excluded by the same-domain fallback path nor by
// isAuthRedirectCapture -- isolating the sameDomainHasGraphql gap on its own.
const MINORITY_HOST = "www.orders-fixture-alerts.example.net";

const ITEM_IDS = ["item-0", "item-1", "item-2"];

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

/**
 * A run dir with NO own-backend hosts declared anywhere. A few captures on a
 * different-registrable-domain minority host land first by array/timestamp
 * order, then the genuinely dominant host's much larger capture count
 * follows. Neither host emits any GraphQL-shaped traffic.
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

  // Cross-registrable-domain minority host's captures, arriving first purely
  // due to async completion timing -- never itself the flow's own backend.
  for (let i = 0; i < 4; i++) {
    write(
      restCapture({
        method: "GET",
        url: `https://${MINORITY_HOST}/ping`,
        requestPostData: null,
        responseBody: { ok: true },
        timestamp: `2026-08-18T10:00:0${i}.000Z`,
      }),
      "minority-host-noise"
    );
  }

  // The dominant host's listing capture, seeding the item ids the declared
  // foldReturn.resultsPath resolves against.
  write(
    restCapture({
      method: "POST",
      url: `https://${DOMINANT_HOST}/api/orders/search`,
      requestPostData: JSON.stringify({ page: 1 }),
      responseBody: { results: ITEM_IDS.map((itemId) => ({ itemId })) },
      timestamp: "2026-08-18T10:01:00.000Z",
    }),
    "list-items"
  );

  // Bulk own-backend read noise on the dominant host, unrelated to the
  // declared submit pattern or the join field -- this is what makes the
  // dominant host genuinely dominant by capture count.
  for (let i = 0; i < 20; i++) {
    write(
      restCapture({
        method: "GET",
        url: `https://${DOMINANT_HOST}/api/orders/availability`,
        requestPostData: null,
        responseBody: { slots: [`slot-${i}`] },
        timestamp: `2026-08-18T10:02:${String(i).padStart(2, "0")}.000Z`,
      }),
      "availability-noise"
    );
  }

  // Genuine submissions matching the declared submitEndpointPattern.
  ITEM_IDS.forEach((itemId, i) => {
    write(
      restCapture({
        method: "POST",
        url: `https://${DOMINANT_HOST}/api/orders/confirm`,
        requestPostData: JSON.stringify({ itemId }),
        responseBody: { status: "confirmed", itemId },
        timestamp: `2026-08-18T10:03:0${i}.000Z`,
      }),
      `confirm-${itemId}`
    );
  });

  // Declared foldReturn drill target.
  write(
    restCapture({
      method: "GET",
      url: `https://${DOMINANT_HOST}/api/orders/detail/slot-2`,
      requestPostData: null,
      responseBody: {
        details: { items: [{ itemId: "item-2", slotCode: "slot-2", guests: 4 }] },
      },
      timestamp: "2026-08-18T10:03:10.000Z",
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

describe("recon-generate CLI — a cross-registrable-domain minority host that sorts first must never anchor baseUrl over the genuinely dominant host", () => {
  it("resolves baseUrl and the generated client's requests to the dominant host, not the array-order-first minority host", () => {
    if (!existsSync(TSX_BIN)) {
      throw new Error("tsx not installed — cannot run the real CLI");
    }
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }

    workDir = mkdtempSync(
      join(tmpdir(), "barnacle-cross-registrable-domain-minority-host-anchor-")
    );
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `cross-registrable-domain-minority-host-anchor-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);
    mkdirSync(siteOutDir, { recursive: true });
    // Deliberately NO `ownBackendHostnames` field, exercising deriveBaseUrl's
    // undeclared-hosts anchor pick against real capture-order timing.
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "check availability" }, { step: "confirm item", submitStep: true }],
        submitEndpointPattern: "orders/confirm",
        requireSubmitEndpointMatch: true,
        foldReturn: {
          endpointPattern: "orders/detail",
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
    // Only the declared submit step ("confirm item") resolves to an actual
    // capture -- "check availability" has no endpointPattern of its own, so
    // the generator legitimately treats this as a single-endpoint REST flow
    // (actionSteps.length === 1), not a multi-step submission flow.
    expect(result.stdout).toContain(`generating plugin for ${siteId} (single-endpoint REST,`);

    const contractPath = join(siteOutDir, "contract.ts");
    const contract = readFileSync(contractPath, "utf8");

    // The regression: baseUrl/primaryHost must resolve to the dominant
    // host's own registrable domain, never the minority host's, no matter
    // which one happened to complete first.
    expect(contract).toContain(DOMINANT_HOST);
    expect(contract).not.toContain(MINORITY_HOST);
    expect(contract).toContain("orders/confirm");
    expect(contract).toContain("itemId");
    expect(contract).toContain("orders/detail");

    // Degenerate-output guard: an anchor mistakenly pinned to the minority
    // host would starve the declared submit/fold patterns of their real
    // matches against the dominant host's captures.
    expect(combinedOutput).not.toContain("disagrees with the unfiltered heuristic action sequence");
    expect(combinedOutput).not.toContain("0 capture(s)");
    expect(combinedOutput).not.toContain("only structurally-detected fold plans");
    expect(combinedOutput).not.toContain("declared joinFields were not applied");

    // The emitted contract must compile cleanly.
    tsconfigPath = join(
      REPO_ROOT,
      `tsconfig.recon-cross-registrable-domain-minority-host-anchor.${process.pid}.json`
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
