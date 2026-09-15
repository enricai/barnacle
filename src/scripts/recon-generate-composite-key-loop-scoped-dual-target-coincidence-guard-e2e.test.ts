import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins the report's exact structural shape end-to-end: a value reached only
 * via a composite, semicolon/equals-delimited map key nested 4+ levels
 * beneath a for-loop-iterated primary array item, whose `pathToVarName`-
 * derived local name coincidentally equals the TRUE literal value of two
 * differently-named submit-body fields (a pagination-like field and a
 * quantity-like field) emitted inside the SAME loop body. Neither field's
 * accessor may thread that local — both are unrelated request-body literals
 * that happen to share the deep leaf's derived name only by coincidence.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.composite-key-loop-scoped-dual-target-coincidence-fixture.example.com";
const LIST_URL = `https://${OWN_BACKEND_HOST}/catalog/search/`;
const SUBMIT_URL = `https://${OWN_BACKEND_HOST}/catalog/select/`;

// Composite, delimiter-bearing map key — `pathToVarName` skips this segment
// entirely (not a valid JS identifier) and falls back to the NEXT ordinary
// segment, `displayOrder`, as the derived local name.
const COMPOSITE_KEY = "variant-a;kind=option;region=x";

// Kept short (well under MIN_STATE_VALUE_LENGTH = 8) so the only way either
// submit-body field could thread the deep leaf is via a broken
// name-correlation gate, not the length-floor bypass.
const DISPLAY_ORDER_VALUE = 4;

// Two differently-named submit-body fields whose TRUE recorded values
// coincidentally equal the deep leaf above — one pagination-like, one
// quantity-like.
const PAGE_INDEX_VALUE = DISPLAY_ORDER_VALUE;
const ITEM_QUANTITY_VALUE = DISPLAY_ORDER_VALUE;

function fixtureCaptures(): Capture[] {
  const list = buildCapture({
    url: LIST_URL,
    requestPostData: '{"page":1}',
    responseBody: {
      sections: [
        {
          itemId: "item-a",
          meta: {
            variants: {
              catalog: {
                [COMPOSITE_KEY]: {
                  displayOrder: DISPLAY_ORDER_VALUE,
                },
              },
            },
          },
        },
        {
          itemId: "item-b",
          meta: {
            variants: {
              catalog: {
                [COMPOSITE_KEY]: {
                  displayOrder: DISPLAY_ORDER_VALUE,
                },
              },
            },
          },
        },
      ],
    },
    timestamp: "2026-01-01T00:00:00Z",
  });

  // Per-iteration submit call, repeated once per `sections` entry — the
  // report's own endpoint-collapse shape — with the loop's own
  // name-correlated `itemId` field alongside the two unrelated collision
  // fields, all emitted inside the SAME loop body.
  const submits = ["item-a", "item-b"].map((itemId, index) =>
    buildCapture({
      url: SUBMIT_URL,
      requestPostData: JSON.stringify({
        itemId,
        pageIndex: PAGE_INDEX_VALUE,
        itemQuantity: ITEM_QUANTITY_VALUE,
      }),
      responseBody: { ok: true },
      timestamp: `2026-01-01T00:00:0${index + 1}Z`,
    })
  );

  return [list, ...submits];
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

describe("recon-generate CLI — loop-scoped composite-key coincidence never threads into two differently-named submit fields", () => {
  it("collapses per-item submits into a genuine loop and leaves both pagination-like and quantity-like fields unthreaded", () => {
    workDir = mkdtempSync(
      join(tmpdir(), "barnacle-composite-key-loop-scoped-dual-target-coincidence-e2e-")
    );
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `composite-key-loop-scoped-dual-target-coincidence-e2e-test${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [{ step: "browse catalog search" }, { step: "select item", submitStep: true }],
        submitEndpointPattern: "catalog/select",
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

    // (a) A genuine `for (const <var> of <sections array>)` loop over the
    // entry response's own array — the repeated per-item submits were
    // collapsed into one loop body, not unrolled per-item httpClient calls.
    expect(contract).toMatch(/\.sections;\n\s*for\s*\(const \w+ of \w+\)/);
    expect(contract.match(/catalog\/select\/`/g)?.length).toBe(1);

    // Isolate the loop-scoped submit call's request-body template literal.
    const bodyLineMatch = contract.match(/catalog\/select\/[\s\S]*?body:\s*`([^`]*)`/);
    expect(bodyLineMatch, contract).not.toBeNull();
    const bodyTemplate = bodyLineMatch![1]!;

    // The genuinely name-correlated field still resolves via its own
    // per-iteration accessor (the loop variable), not a frozen literal.
    const itemIdLine = bodyTemplate.match(/"itemId"\s*:\s*"?\$\{([^}]*)\}"?/);
    expect(itemIdLine, bodyTemplate).not.toBeNull();
    expect(itemIdLine![1]).toMatch(/\.itemId/);

    // Neither the pagination-like nor the quantity-like collision field's
    // template-literal source may match the deep leaf's own derived name
    // (`displayOrder`) or leak the raw composite key text — the only way
    // either could resolve to the deep leaf despite the name-correlation
    // gate.
    const pageIndexLine = bodyTemplate.match(/"pageIndex"\s*:\s*"?([^,\n}]*)"?/);
    expect(pageIndexLine, bodyTemplate).not.toBeNull();
    if (pageIndexLine![1]!.includes("${")) {
      expect(pageIndexLine![1]).not.toMatch(/displayorder/i);
      expect(pageIndexLine![1]).not.toMatch(/variant-a|kind=option|region=x/i);
    }
    const itemQuantityLine = bodyTemplate.match(/"itemQuantity"\s*:\s*"?([^,\n}]*)"?/);
    expect(itemQuantityLine, bodyTemplate).not.toBeNull();
    if (itemQuantityLine![1]!.includes("${")) {
      expect(itemQuantityLine![1]).not.toMatch(/displayorder/i);
      expect(itemQuantityLine![1]).not.toMatch(/variant-a|kind=option|region=x/i);
    }

    // No invalidly-nested placeholder anywhere in the emitted body.
    expect(bodyTemplate).not.toMatch(/\$\{[^}]*\$\{/);

    // The emitted contract.ts must typecheck with zero diagnostics.
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }
    tsconfigPath = join(
      REPO_ROOT,
      `tsconfig.composite-key-loop-scoped-dual-target-coincidence.${process.pid}.json`
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
    const referencesEmittedFile = diagnostics.includes("contract.ts");
    expect(referencesEmittedFile, diagnostics).toBe(false);
    expect(check.status, diagnostics).toBe(0);
  }, 60_000);
});
