import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { Capture } from "@/scripts/recon-shared";

/**
 * The conceptually dominant acceptance test for this investigation: one
 * synthetic, site-agnostic archive whose captures simultaneously satisfy all
 * four reported symptoms together (never contradicting each other), driven
 * through the real `recon-generate` CLI entrypoint — the same spawnSync-the-
 * real-CLI + throwaway-tsconfig convention the sibling *-e2e.test.ts files in
 * this directory already establish. Unlike the per-symptom regression files,
 * this one's noise host label matches neither the auth nor the
 * marketing/landing vocabulary {@link recon-generate.ts}'s
 * `isSameCompanyRedirectCapture` special-cases, so the agreement proven here
 * rests on the general dominant-host-by-count anchor pick, not a label-based
 * carve-out.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const PRIMARY_HOST = "api.order-fixture.example.com";
// Same-company noise on a genuinely different eTLD+1, whose first label
// ("cdn") names neither an auth/login bounce nor a marketing/landing one, so
// it is never excluded from the anchor-pick candidate pool by label alone —
// only the real backend's dominance by capture count can resolve it.
const NOISE_HOST = "cdn.order-fixture-assets.example.net";

const ITEM_IDS = ["item-0", "item-1", "item-2", "item-3"];

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
 * Noise/redirect captures on `NOISE_HOST`, sorted FIRST in array order (a
 * same-company asset host that happens to resolve before the in-flight
 * primary request), plus the real backend's listing, declared-pattern
 * submissions, and declared fold drill target.
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

  const noise = (i: number): void =>
    write(
      restCapture({
        method: "GET",
        url: `https://${NOISE_HOST}/static/banner-${i}.json`,
        requestPostData: null,
        responseBody: { asset: `banner-${i}` },
        timestamp: `2026-09-10T09:0${Math.floor(i / 6)}:${String((i * 7) % 60).padStart(2, "0")}.000Z`,
      }),
      `noise-${i}`
    );

  // Noise sorts first, purely due to async completion timing.
  for (let i = 0; i < 3; i++) noise(i);

  // The dominant primary host's listing capture, seeding the item ids the
  // declared foldReturn.resultsPath resolves against.
  write(
    restCapture({
      method: "POST",
      url: `https://${PRIMARY_HOST}/api/orders/search`,
      requestPostData: JSON.stringify({ page: 1 }),
      responseBody: { results: ITEM_IDS.map((itemId) => ({ itemId })) },
      timestamp: "2026-09-10T09:10:00.000Z",
    }),
    "list-items"
  );

  // More noise interleaved mid-archive, not confined to a single block.
  noise(3);
  noise(4);

  // Bulk own-backend read noise, unrelated to the declared submit pattern or
  // the join field — makes the dominant host genuinely dominant by count.
  for (let i = 0; i < 14; i++) {
    write(
      restCapture({
        method: "GET",
        url: `https://${PRIMARY_HOST}/api/orders/availability`,
        requestPostData: null,
        responseBody: { slots: [`slot-${i}`] },
        timestamp: `2026-09-10T09:11:${String(i).padStart(2, "0")}.000Z`,
      }),
      `availability-noise-${i}`
    );
    if (i === 3 || i === 9) noise(5 + i);
  }

  // Genuine submissions matching the declared submitEndpointPattern, each
  // separated by noise or availability captures so no contiguous run of
  // "real" captures exists in array order either. The instruction step
  // below (see recon-flow.json) splices this same `itemId` value, so this
  // is also the archive's declared-persona-value binding source.
  ITEM_IDS.forEach((itemId, i) => {
    write(
      restCapture({
        method: "POST",
        url: `https://${PRIMARY_HOST}/api/orders/confirm`,
        requestPostData: JSON.stringify({ itemId }),
        responseBody: { status: "confirmed", itemId },
        timestamp: `2026-09-10T09:12:0${i}.000Z`,
      }),
      `confirm-${itemId}`
    );
  });

  // Trailing noise after the genuine submissions, proving late-arriving
  // cross-domain traffic can't flip classification either.
  noise(20);

  // Declared foldReturn drill target: its URL threads `slotCode`, never the
  // declared join field. `joinFields: ["itemId"]` only ever appears in the
  // response body here, forcing the response-only resolution path over a
  // structural guess.
  write(
    restCapture({
      method: "GET",
      url: `https://${PRIMARY_HOST}/api/orders/detail/slot-2`,
      requestPostData: null,
      responseBody: {
        details: { items: [{ itemId: "item-2", slotCode: "slot-2", guests: 4 }] },
      },
      timestamp: "2026-09-10T09:13:00.000Z",
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

describe("recon-generate CLI — base-url anchor, REST classification, declared submit/fold resolution, and compile-safe template emission agree on one combined archive", () => {
  it("resolves the real backend's host, classifies REST, matches the declared submit pattern, resolves the declared join field, and emits compiling flow/contract sources despite a backtick/splice-interpolation hazard", () => {
    if (!existsSync(TSX_BIN)) {
      throw new Error("tsx not installed — cannot run the real CLI");
    }
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }

    workDir = mkdtempSync(join(tmpdir(), "barnacle-cross-domain-noise-cascade-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot);

    const siteId = `cross-domain-noise-cascade-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    expect(existsSync(siteOutDir)).toBe(false);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "check availability" },
          // The hazard: a literal backtick AND a `${`-shaped sequence sit in
          // the instruction text surrounding the quoted persona value that
          // correlates with the confirm captures' `itemId` field — this must
          // be neutralized, not left to terminate the emitted template
          // literal early or splice unintended interpolation.
          {
            // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture instruction text, not a template
            step: "Enter the `confirmed ${slot}` order id into the 'item-2' field",
            payloadField: "itemId",
            submitStep: true,
          },
        ],
        submitEndpointPattern: "orders/confirm",
        requireSubmitEndpointMatch: true,
        ownBackendHostnames: [PRIMARY_HOST, NOISE_HOST],
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

    // Symptom #1 — base URL / classification: the dominant real backend's
    // registrable domain anchors baseUrl/primaryHost (not the noise host
    // that sorts first), so REST classification agrees with the real
    // traffic even though the noise host's label matches neither the
    // auth nor the marketing/landing vocabulary.
    expect(result.stdout).toContain(`generating plugin for ${siteId} (submission flow,`);
    expect(result.stdout).not.toContain(`generating plugin for ${siteId} (GraphQL,`);
    expect(result.stdout).not.toContain("GraphQL");

    // Symptom #2 — submit pattern: every genuine declared-pattern match on
    // the dominant host must be counted, not discarded as "0 capture(s)" or
    // a spurious disagreement against the unfiltered heuristic action
    // sequence starved by the interleaved noise.
    expect(combinedOutput).not.toContain("declared submitEndpointPattern/submitBodyPattern");
    expect(combinedOutput).not.toContain("disagrees with the unfiltered heuristic action sequence");
    expect(combinedOutput).not.toContain("0 capture(s)");
    expect(combinedOutput).not.toContain("undercount");

    // Symptom #3 — fold join field: the declared spec resolves via the real
    // drill response, not a guessed structural fallback keyed on slotCode.
    expect(combinedOutput).not.toContain("no fold plan resolved");
    expect(combinedOutput).not.toContain("only structurally-detected fold plans");
    expect(combinedOutput).not.toContain("declared joinFields were not applied");

    const contractPath = join(siteOutDir, "contract.ts");
    const contract = readFileSync(contractPath, "utf8");

    expect(contract).toContain(PRIMARY_HOST);
    expect(contract).not.toContain(NOISE_HOST);
    expect(contract).toContain("orders/confirm");
    expect(contract).toContain("itemId");
    expect(contract).toContain("orders/detail");
    expect(contract).not.toContain("createGraphqlClient");

    const browserFlowPath = join(siteOutDir, "flows", "browser-flow.ts");
    const browserFlow = readFileSync(browserFlowPath, "utf8");

    // Symptom #4 — the hazardous instruction text must be re-emitted with
    // its literal backtick and `${` neutralized, never left able to
    // terminate the surrounding template literal early.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    expect(browserFlow).toContain("\\`confirmed \\${slot}\\`");

    // Symptom #4 — both emitted sources must typecheck cleanly, with no
    // undeclared-identifier/unterminated-template-literal references, the
    // compile-failure shape the original report observed.
    tsconfigPath = join(REPO_ROOT, `tsconfig.cross-domain-noise-cascade.${process.pid}.json`);
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
