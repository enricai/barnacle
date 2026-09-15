import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins the report's actual repro shape end-to-end: a repeated-endpoint-
 * collapse for-loop whose per-iteration submit call sits nested inside the
 * loop body, where several of that submit body's fields (one numeric, one
 * boolean) coincidentally equal a value frozen from the loop's own
 * ancestor/entry response and reached only via a deep, semicolon-delimited
 * bracket-keyed accessor path (mirroring the report's own composite-key
 * shape). Neither collision field may resolve to that ancestor accessor —
 * both values are request-body literals correlated to nothing but
 * themselves — while the genuinely name-correlated `itemId` field must
 * still resolve off the per-iteration loop variable. The emitted
 * contract.ts must also typecheck clean.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.loop-ancestor-value-coincidence-multifield-fixture.example.com";
const LIST_URL = `https://${OWN_BACKEND_HOST}/catalog/search/`;
const SUBMIT_URL = `https://${OWN_BACKEND_HOST}/catalog/select/`;

// Semicolon-delimited composite object key, mirroring the report's
// stateroom-category shape, wrapping the two ancestor leaves under test.
const COMPOSITE_KEY = "DD-INSIDE;entityType=stateroom-type;destination=dcl";

// Both kept short (well under MIN_STATE_VALUE_LENGTH = 8) so the only way
// either could thread into an unrelated submit-body field is via a broken
// name-correlation gate, not the length-floor bypass.
const DISPLAY_ORDER_VALUE = 3;
const IS_PROMO_VALUE = true;

// The submit body's own, differently-named fields that coincidentally carry
// the SAME values as the two ancestor leaves above — one numeric, one
// boolean.
const PRIORITY_RANK_VALUE = DISPLAY_ORDER_VALUE;
const FEATURED_VALUE = IS_PROMO_VALUE;

function fixtureCaptures(): Capture[] {
  const list = buildCapture({
    url: LIST_URL,
    requestPostData: '{"page":1}',
    responseBody: {
      sections: [{ itemId: "item-a" }, { itemId: "item-b" }],
      meta: {
        stateroomTypes: {
          [COMPOSITE_KEY]: {
            displayOrder: DISPLAY_ORDER_VALUE,
            isPromo: IS_PROMO_VALUE,
          },
        },
      },
    },
    timestamp: "2026-01-01T00:00:00Z",
  });

  // Per-iteration submit call, repeated once per `sections` entry — the
  // report's own endpoint-collapse shape — with the loop's own
  // name-correlated `itemId` field alongside the two unrelated collision
  // fields.
  const submits = ["item-a", "item-b"].map((itemId, index) =>
    buildCapture({
      url: SUBMIT_URL,
      requestPostData: JSON.stringify({
        itemId,
        priorityRank: PRIORITY_RANK_VALUE,
        featured: FEATURED_VALUE,
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

describe("recon-generate CLI — for-loop-nested submit body never threads a frozen ancestor's bracket-keyed value into unrelated fields", () => {
  it("collapses per-item submits into a genuine loop, resolves itemId by name, and leaves both value-coincident fields unthreaded", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-loop-ancestor-value-coincidence-multifield-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `loop-ancestor-value-coincidence-multifield-e2e-test${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "browse catalog search" },
          { step: "select item", submitStep: true },
        ],
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
    // entry response's own array — the endpoint-collapse mechanism folded
    // the repeated per-item submits into one loop body, not one unrolled
    // httpClient call per item.
    expect(contract).toMatch(/\.sections;\n\s*for\s*\(const \w+ of \w+\)/);
    expect(contract.match(/catalog\/select\/`/g)?.length).toBe(1);

    // Isolate the submit call's request-body template literal.
    const bodyLineMatch = contract.match(/catalog\/select\/[\s\S]*?body:\s*`([^`]*)`/);
    expect(bodyLineMatch, contract).not.toBeNull();
    const bodyTemplate = bodyLineMatch![1]!;

    // (c) The genuinely name-correlated field still resolves via its own
    // per-iteration accessor (the loop variable), not a frozen literal.
    const itemIdLine = bodyTemplate.match(/"itemId"\s*:\s*"?\$\{([^}]*)\}"?/);
    expect(itemIdLine, bodyTemplate).not.toBeNull();
    expect(itemIdLine![1]).toMatch(/\.itemId/);

    // (b) Neither differently-named collision field's template-literal
    // source may match the ancestor local's own derived name
    // (`displayOrder`/`isPromo`) or leak the raw composite key text — the
    // only way either could resolve to the frozen ancestor leaf despite the
    // name-correlation gate.
    const priorityRankLine = bodyTemplate.match(/"priorityRank"\s*:\s*"?([^,\n}]*)"?/);
    expect(priorityRankLine, bodyTemplate).not.toBeNull();
    if (priorityRankLine![1]!.includes("${")) {
      expect(priorityRankLine![1]).not.toMatch(/displayorder/i);
      expect(priorityRankLine![1]).not.toMatch(/dd-inside|stateroom|destination=dcl/i);
    }
    const featuredLine = bodyTemplate.match(/"featured"\s*:\s*"?([^,\n}]*)"?/);
    expect(featuredLine, bodyTemplate).not.toBeNull();
    if (featuredLine![1]!.includes("${")) {
      expect(featuredLine![1]).not.toMatch(/ispromo/i);
      expect(featuredLine![1]).not.toMatch(/dd-inside|stateroom|destination=dcl/i);
    }

    // No invalidly-nested placeholder anywhere in the emitted body.
    expect(bodyTemplate).not.toMatch(/\$\{[^}]*\$\{/);

    // (d) The emitted contract.ts must typecheck with zero diagnostics.
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }
    tsconfigPath = join(
      REPO_ROOT,
      `tsconfig.loop-ancestor-value-coincidence-multifield.${process.pid}.json`
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
