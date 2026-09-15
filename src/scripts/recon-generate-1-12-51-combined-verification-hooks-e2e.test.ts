import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Combined e2e pinning the 1.12.51 report's own "Verification hooks" section
 * as a single artifact: one CLI-generated contract.ts exercising BOTH
 * remaining defects together — (a) a payload field (`storeCurrency`) that is
 * legitimately sourced from `payload.storeCurrency` on the entry call, and
 * must keep sourcing from `payload.storeCurrency` on a later call even
 * though an intervening response coincidentally reproduces the same value at
 * a nested, unrelated path; and (b) a separately-captured top-level boolean
 * response field (`specialOfferEnabled`) that must be both
 * response-schema-inferred as `z.boolean()` and extraction-cast as
 * `boolean`, never `string`, when it is re-threaded into a later request. A
 * `tsc --noEmit` gate on the same emitted output pins the report's typecheck
 * claim over the identical artifact the two field-level assertions check.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.combined-verification-hooks-e2e-fixture.example.com";
const SEARCH_URL = `https://${OWN_BACKEND_HOST}/catalog/search/`;
const DETAIL_URL = `https://${OWN_BACKEND_HOST}/catalog/detail/`;
const SUBMIT_URL = `https://${OWN_BACKEND_HOST}/catalog/submit/`;

// Exactly MIN_STATE_VALUE_LENGTH (8) so it legitimately qualifies for
// ordinary state-value indexing (no fold/drill exemption needed) — the
// intervening call's coincidentally-equal nested occurrence is a genuine
// competing accessor, not a value too short to ever be indexed.
const STORE_CURRENCY_VALUE = "usdcurr1";

function fixtureCaptures(): Capture[] {
  // Entry call: `storeCurrency` is the caller's own top-level field — the
  // legitimate `payload.storeCurrency` source that must keep winning on the
  // later submit call too. The listing response is an array so the detail
  // call below is reached through the generator's genuine per-item fold
  // loop, the code path the extraction-cast defect lives on.
  const search = buildCapture({
    url: SEARCH_URL,
    requestPostData: JSON.stringify({ storeCurrency: STORE_CURRENCY_VALUE, page: 1 }),
    responseBody: { results: [{ itemId: "item-a" }] },
    timestamp: "2026-06-01T00:00:00Z",
  });
  // Intervening per-item detail call: the same value is coincidentally
  // reproduced at a nested, unrelated path (meta.storeCurrency) — the
  // scraped occurrence that must never win over payload.storeCurrency on
  // the later submit call. It also carries the top-level boolean leaf that
  // must be both schema-inferred as z.boolean() and extraction-cast as
  // boolean.
  const detail = buildCapture({
    url: DETAIL_URL,
    requestPostData: JSON.stringify({ itemId: "item-a" }),
    responseBody: {
      itemId: "item-a",
      meta: { storeCurrency: STORE_CURRENCY_VALUE },
      specialOfferEnabled: true,
    },
    timestamp: "2026-06-01T00:00:01Z",
  });
  // Terminal submit call: re-sends both fields under their own names — must
  // resolve `storeCurrency` from `payload.storeCurrency` and
  // `specialOfferEnabled` via a boolean-typed extraction.
  const submit = buildCapture({
    url: SUBMIT_URL,
    requestPostData: JSON.stringify({
      itemId: "item-a",
      storeCurrency: STORE_CURRENCY_VALUE,
      specialOfferEnabled: true,
    }),
    responseBody: { ok: true },
    timestamp: "2026-06-01T00:00:02Z",
  });
  return [search, detail, submit];
}

function writeRunDir(root: string, captures: Capture[]): void {
  mkdirSync(join(root, "graphql"), { recursive: true });
  mkdirSync(join(root, "replays"), { recursive: true });
  mkdirSync(join(root, "aux"), { recursive: true });
  writeFileSync(join(root, "replays", "rate-limit.json"), JSON.stringify([]));
  captures.forEach((capture, index) => {
    writeFileSync(
      join(root, "graphql", `${String(index).padStart(3, "0")}-capture.json`),
      JSON.stringify(capture)
    );
  });
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

describe("recon-generate CLI — combined 1.12.51 verification-hooks e2e", () => {
  it("sources payload.storeCurrency on every call AND extraction-casts specialOfferEnabled as boolean, over a single typechecked contract.ts", () => {
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }

    workDir = mkdtempSync(join(tmpdir(), "barnacle-combined-verification-hooks-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `combined-verification-hooks-e2e-test${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "browse catalog search" },
          { step: "open item detail panel" },
          { step: "submit item selection", submitStep: true },
        ],
        submitEndpointPattern: "catalog/submit",
        requireSubmitEndpointMatch: true,
        ownBackendHostnames: [OWN_BACKEND_HOST],
      })
    );

    const result = spawnSync(
      TSX_BIN,
      [GENERATE_SCRIPT, "--site-id", siteId, "--run-dir", runRoot, "--emit", "ts", "--force"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const contractPath = join(siteOutDir, "contract.ts");
    const contract = readFileSync(contractPath, "utf8");

    // Verification hook 1 — payload precedence: every request-body
    // occurrence of the field must source from `payload.storeCurrency`,
    // never from the coincidentally-equal scraped meta.storeCurrency
    // accessor.
    const storeCurrencyOccurrences = [
      ...contract.matchAll(/"storeCurrency"\s*:\s*"?\$\{([^}]*)\}"?/g),
    ];
    expect(storeCurrencyOccurrences.length).toBeGreaterThanOrEqual(2);
    for (const match of storeCurrencyOccurrences) {
      expect(match[1], contract).toContain("payload.storeCurrency");
    }
    expect(contract).not.toMatch(/"storeCurrency"\s*:\s*"?\$\{[^}]*meta[^}]*\}/i);

    // Verification hook 2 — extraction-cast/schema type parity: the
    // response-schema inference and the extraction cast must agree.
    expect(contract).toMatch(/specialOfferEnabled:\s*z\.boolean\(\)/);
    const castMatch = contract.match(/as \{ specialOfferEnabled: (\w+) \}/);
    expect(castMatch, contract).not.toBeNull();
    expect(castMatch![1]).toBe("boolean");
    expect(contract).not.toMatch(/as \{ specialOfferEnabled: string \}/);

    // No invalidly-nested placeholder anywhere in the emitted output.
    expect(contract).not.toMatch(/\$\{[^}]*\$\{/);

    // The emitted contract.ts must typecheck with zero diagnostics against
    // the discovered PayloadSchema — the report's own typecheck claim, over
    // the identical artifact the two field-level assertions above check.
    tsconfigPath = join(REPO_ROOT, `tsconfig.combined-verification-hooks-e2e.${process.pid}.json`);
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
    const referencesEmittedFile = diagnostics.includes("contract.ts");
    expect(referencesEmittedFile, diagnostics).toBe(false);
    expect(check.status, diagnostics).toBe(0);
  }, 60_000);
});
