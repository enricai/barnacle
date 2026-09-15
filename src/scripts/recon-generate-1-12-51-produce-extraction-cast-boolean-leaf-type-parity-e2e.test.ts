import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins the report's string/boolean cast mismatch: a produce-extraction cast
 * for a response-produced value must agree with the same field's runtime
 * type, not a hardcoded `string`. Each per-item drill hop's own response
 * carries a bare JSON boolean (`passed`), which `compileActionSteps` walks
 * via `walkAllPrimitiveLeaves` (not a string-only walk) and threads into the
 * next per-item hop's request body — so the produce has always existed; the
 * extraction cast just mistyped it. Drives the real `recon:generate --force`
 * CLI so the emitted `contract.ts` is checked both textually (the cast reads
 * `boolean`, not `string`) and via `tsc --noEmit` (the report's own
 * suggested verification hook), matching the schema-inferred `z.boolean()`
 * the SAME field gets on the producing call's own response schema.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.produce-extraction-boolean-leaf-cast-fixture.example.com";
const SEARCH_URL = `https://${OWN_BACKEND_HOST}/catalog/search/`;
const VERIFY_URL = `https://${OWN_BACKEND_HOST}/catalog/verify/`;
const FINALIZE_URL = `https://${OWN_BACKEND_HOST}/catalog/finalize/`;
const SUBMIT_URL = `https://${OWN_BACKEND_HOST}/catalog/submit/`;

function fixtureCaptures(): Capture[] {
  const search = buildCapture({
    url: SEARCH_URL,
    requestPostData: '{"page":1}',
    responseBody: { results: [{ itemId: "item-a" }, { itemId: "item-b" }] },
    timestamp: "2026-05-01T00:00:00Z",
  });
  // Each per-item verify hop's own response is a bare boolean leaf
  // (`passed`) — both response-schema-inferred as z.boolean() AND, since the
  // next hop's request re-sends it under the SAME field name, threaded
  // forward as a produce-extraction cast.
  const verifyA = buildCapture({
    url: VERIFY_URL,
    requestPostData: '{"itemId":"item-a"}',
    responseBody: { passed: true },
    timestamp: "2026-05-01T00:00:01Z",
  });
  const finalizeA = buildCapture({
    url: FINALIZE_URL,
    requestPostData: '{"itemId":"item-a","passed":true}',
    responseBody: { entries: [{ itemId: "item-a", status: "ok" }] },
    timestamp: "2026-05-01T00:00:02Z",
  });
  const verifyB = buildCapture({
    url: VERIFY_URL,
    requestPostData: '{"itemId":"item-b"}',
    responseBody: { passed: false },
    timestamp: "2026-05-01T00:00:03Z",
  });
  const finalizeB = buildCapture({
    url: FINALIZE_URL,
    requestPostData: '{"itemId":"item-b","passed":false}',
    responseBody: { entries: [{ itemId: "item-b", status: "ok" }] },
    timestamp: "2026-05-01T00:00:04Z",
  });
  const submit = buildCapture({
    url: SUBMIT_URL,
    requestPostData: '{"itemId":"item-a"}',
    responseBody: { ok: true },
    timestamp: "2026-05-01T00:00:05Z",
  });
  return [search, verifyA, finalizeA, verifyB, finalizeB, submit];
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

describe("recon-generate CLI + tsc --noEmit — produce-extraction cast types a boolean leaf as boolean", () => {
  it("emits `as { passed: boolean }`, never `as { passed: string }`, for a drill-hop-threaded boolean produce, and typechecks clean", () => {
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }

    workDir = mkdtempSync(join(tmpdir(), "barnacle-produce-extraction-boolean-leaf-cast-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `produce-extraction-boolean-leaf-cast-test-p${process.pid}x`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "browse catalog search" },
          { step: "verify item" },
          { step: "finalize item" },
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

    // The verify hop's own response schema infers the SAME field as
    // z.boolean() — the assertion below must agree with it, not hardcode
    // `string`.
    expect(contract).toMatch(/passed:\s*z\.boolean\(\)/);

    // The produce-extraction cast must type the leaf as `boolean` — matching
    // the schema-inferred type for the same field — never the hardcoded
    // `string` the stale invariant used to emit.
    const passedAssertion = contract.match(/as \{ passed: (\w+) \}/);
    expect(passedAssertion, contract).not.toBeNull();
    expect(passedAssertion![1]).toBe("boolean");
    expect(contract).not.toMatch(/as \{ passed: string \}/);

    tsconfigPath = join(
      REPO_ROOT,
      `tsconfig.produce-extraction-boolean-leaf-cast.${process.pid}.json`
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
    const referencesEmittedFiles = diagnostics.includes("contract.ts");
    expect(referencesEmittedFiles, diagnostics).toBe(false);
    expect(check.status, diagnostics).toBe(0);
  }, 60_000);
});
