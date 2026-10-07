import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins that every navigateTo-declared payloadField facet binds to its own
 * `payload.<field>` regardless of its position or the hashless reset
 * navigations interleaved between facets. Each facet navigateTo carries a
 * cumulative comma-joined hash, so a binder that reads the whole hash (or is
 * reset by a hashless navigation) collapses facets onto one value.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.declared-facets-reach-requests-fixture.example.com";
const BASE_URL = `https://${OWN_BACKEND_HOST}/`;

const NAV = { token: "apparel-q1", field: "DepartmentFacet", key: "slotOne" };
const SELECTS: ReadonlyArray<{ label: string; value: string; field: string; key: string }> = [
  { label: "Departure", value: "Lisbon", field: "DeparturePort", key: "origin" },
  { label: "Theme", value: "Heritage", field: "ThemeFacet", key: "mood" },
  { label: "Nights", value: "Seven", field: "NightsFacet", key: "length" },
];
const UNBOUND_FIELD = "GhostFacet";

function fixtureCaptures(): Capture[] {
  const filterBody: Record<string, unknown> = { sort: "relevance", [NAV.key]: NAV.token };
  for (const s of SELECTS) filterBody[s.key] = s.value;
  return [
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/catalog/browse/`,
      requestPostData: JSON.stringify({ sort: "relevance" }),
      responseBody: { ok: true },
      timestamp: "2026-02-01T00:00:00.000Z",
    }),
    buildCapture({
      url: `https://${OWN_BACKEND_HOST}/catalog/filter-results/`,
      requestPostData: JSON.stringify(filterBody),
      responseBody: { ok: true },
      timestamp: "2026-02-01T00:00:01.000Z",
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

describe("recon-generate CLI — declared facets on mixed step kinds reach the requests", () => {
  it("binds navigateTo and non-navigateTo facets as payload.<field>; an unmatched facet stays unbound", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-declared-facets-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `declared-facets-reach-requests-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          {
            step: "navigate to the catalog with the department applied",
            navigateTo: `${BASE_URL}#${NAV.token}`,
            payloadField: NAV.field,
          },
          ...SELECTS.map((s) => ({
            step: `select '${s.value}' from the ${s.label} dropdown`,
            payloadField: s.field,
          })),
          { step: "choose a ghost", payloadField: UNBOUND_FIELD },
          { step: "browse catalog" },
          { step: "apply filters", submitStep: true },
        ],
        submitEndpointPattern: "catalog/filter-results",
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

    const contract = readFileSync(join(siteOutDir, "contract.ts"), "utf8");
    const combinedBody = [...contract.matchAll(/body: (`.*`),\s*\n\s*schema:/g)]
      .map((m) => m[1] ?? "")
      .join("\n");
    expect(combinedBody.length, contract).toBeGreaterThan(0);

    for (const field of [NAV.field, ...SELECTS.map((s) => s.field)])
      expect(combinedBody, `${field} missing in: ${combinedBody}`).toContain(
        `\${payload.${field}}`
      );
    expect(combinedBody).not.toContain(`\${payload.${UNBOUND_FIELD}}`);
    expect(combinedBody).not.toContain(NAV.token);
    for (const s of SELECTS) expect(combinedBody).not.toContain(s.value);
  }, 30_000);
});
