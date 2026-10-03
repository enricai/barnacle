import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Regression guard against the navigateTo-skip fix (recon-generate.ts:13793)
 * over-correcting. A navigateTo step with no explicit `payloadField` (and
 * instruction text that vocabulary-matches nothing) must still contribute no
 * field to `payloadFieldNames` — it falls through `continue` exactly as it
 * did before the fix. A sibling request carries the same URL-hash-fragment
 * text the navigation target names; that text must never become a schema
 * field or a `payload.<field>` accessor.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.navigateto-no-payloadfield-regression-fixture.example.com";
const CATEGORY_FRAGMENT = "gadgets";

function fixtureCaptures(): Capture[] {
  return [
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/catalog/search/`,
      requestPostData: JSON.stringify({ sort: "relevance" }),
      requestHeaders: {
        "Content-Type": "application/json",
        "X-Catalog-Category": CATEGORY_FRAGMENT,
      },
      responseBody: { ok: true },
      timestamp: "2026-01-01T00:00:00.000Z",
    }),
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/catalog/submit/`,
      requestPostData: JSON.stringify({ category: CATEGORY_FRAGMENT, confirm: true }),
      responseBody: { ok: true },
      timestamp: "2026-01-01T00:00:01.000Z",
    }),
  ];
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

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (siteOutDir) rmSync(siteOutDir, { recursive: true, force: true });
  workDir = null;
  siteOutDir = null;
});

describe("recon-generate CLI — navigateTo step without an explicit payloadField stays excluded", () => {
  it("never registers the navigation target's own text as a payload field or schema entry", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-navigateto-no-payloadfield-regression-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `navigateto-no-payloadfield-regression-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          {
            step: "navigate to the gadgets catalog category page",
            navigateTo: `https://${OWN_BACKEND_HOST}/#/catalog/${CATEGORY_FRAGMENT}`,
          },
          { step: "browse catalog search" },
          { step: "submit catalog search", submitStep: true },
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

    const payloadAccessor = `\${payload.${CATEGORY_FRAGMENT}}`;
    expect(contract).not.toContain(payloadAccessor);
    expect(contract).not.toMatch(new RegExp(`payload\\.${CATEGORY_FRAGMENT}\\b`, "i"));

    const schemaMatch = contract.match(
      /PayloadSchema = z\.object\(\{[\s\S]*?\n\}\)(?:\.extend\(\{[\s\S]*?\n\}\))?;/
    );
    expect(schemaMatch, contract).not.toBeNull();
    const schema = schemaMatch?.[0] ?? "";
    expect(schema).not.toMatch(new RegExp(`\\b${CATEGORY_FRAGMENT}:`, "i"));
  }, 30_000);
});
