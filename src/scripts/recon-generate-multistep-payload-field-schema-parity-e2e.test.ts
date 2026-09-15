import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins bugfix-002: emitMultiStepExecuteHttp's outDiscoveredFields parameter
 * accumulates several field sources unrelated to form-schema discovery —
 * BaseUrl substitution, persona bindings, and tenant-subdomain headers among
 * them (recon-generate.ts:5688-5773). Every field it registers must actually
 * reach emitContractTs's schema `.extend()`, or the emitted contract.ts
 * references a `payload.<field>` the PayloadSchema never declares (TS2339).
 * Drives the real CLI end to end (mirrors
 * recon-generate-1-12-50-payload-schema-body-field-parity-tsc-e2e.test.ts's
 * harness), then runs `tsc --noEmit` against the emitted contract.ts.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const TENANT_SUBDOMAIN = "acmehr";
const OWN_BACKEND_HOST = `${TENANT_SUBDOMAIN}.multistep-field-parity-fixture.example.com`;
const LIST_URL = `https://${OWN_BACKEND_HOST}/jobs/search/`;
const DETAIL_URL = `https://${OWN_BACKEND_HOST}/jobs/detail/`;
const SUBMIT_URL = `https://${OWN_BACKEND_HOST}/jobs/apply/`;

// Long enough to clear MIN_STATE_VALUE_LENGTH (8) for BaseUrl substitution.
const MIDDLE_NAME_VALUE = "Bartholomew";

function fixtureCaptures(): Capture[] {
  const listPage = buildCapture({
    url: LIST_URL,
    requestPostData: null,
    requestHeaders: { "Content-Type": "application/json", "API-ShortName": TENANT_SUBDOMAIN },
    responseBody: { totalPages: 1, results: [{ itemId: "req-1" }] },
    timestamp: "2026-02-01T00:00:00Z",
  });
  const detail = buildCapture({
    url: DETAIL_URL,
    requestPostData: JSON.stringify({ itemId: "req-1" }),
    requestHeaders: { "Content-Type": "application/json", "API-ShortName": TENANT_SUBDOMAIN },
    responseBody: { title: "Warehouse Associate" },
    timestamp: "2026-02-01T00:00:01Z",
  });
  const submit = buildCapture({
    url: SUBMIT_URL,
    requestPostData: JSON.stringify({
      itemId: "req-1",
      middleName: MIDDLE_NAME_VALUE,
      apiOrigin: `https://${OWN_BACKEND_HOST}`,
    }),
    requestHeaders: { "Content-Type": "application/json", "API-ShortName": TENANT_SUBDOMAIN },
    responseBody: { ok: true },
    timestamp: "2026-02-01T00:00:02Z",
  });
  return [listPage, detail, submit];
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

describe("recon-generate CLI + tsc --noEmit — emitMultiStepExecuteHttp's generic payload-accessor fields stay declared on PayloadSchema", () => {
  it("emits a contract.ts whose BaseUrl / persona / tenant-subdomain-header payload accessors typecheck clean", () => {
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }

    workDir = mkdtempSync(join(tmpdir(), "barnacle-multistep-field-parity-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `multistep-field-parity-e2e-test${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "browse job search" },
          { step: "open job detail panel" },
          {
            step: "fill in the Middle Name field with 'Bartholomew'",
            payloadField: "middleName",
          },
          { step: "submit job application", submitStep: true },
        ],
        submitEndpointPattern: "jobs/apply",
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
    expect(existsSync(contractPath)).toBe(true);
    const contract = readFileSync(contractPath, "utf8");

    // Every payload accessor emitMultiStepExecuteHttp can register — BaseUrl,
    // the persona-bound field, and the tenant-subdomain header field — must
    // actually appear as a `payload.<field>` reference for the assertion below
    // to exercise the parity this test pins.
    expect(contract).toMatch(/payload\.BaseUrl/);

    tsconfigPath = join(REPO_ROOT, `tsconfig.multistep-field-parity.${process.pid}.json`);
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
