import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  applyStructuredValuePayloadSubstitutions,
  type StateVarBinding,
} from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins the fix in `applyStructuredValuePayloadSubstitutionsForEnvelope`
 * (recon-generate.ts): a structured (array-of-objects) body field whose
 * wholesale `${JSON.stringify(payload.<key>)}` swallow is skipped by an
 * exclusion source (a recurring facet literal) or an already-spliced span
 * must still get its correct `z.array(z.object(...))` schema registered.
 * Before the fix, schema registration only happened AFTER a successful
 * wholesale swallow, so any early `continue` left the field defaulted to
 * `z.string()` on the emitted contract while body-construction code kept
 * emitting array/object accessors against it — a schema/body type
 * divergence that fails `tsc`. Uses a generic multi-criterion sort-order
 * field in a travel-search domain fixture, not any real plugin's shape.
 */

describe("applyStructuredValuePayloadSubstitutions — array-of-objects schema registered despite swallow exclusion", () => {
  it("registers z.array(z.object(...)) for a structured field excluded from the wholesale swallow by a threaded facet literal", () => {
    const parsedBody = {
      sortCriteria: [
        { field: "price", direction: "asc" },
        { field: "destination-hub-7731", direction: "desc" },
      ],
    };
    const template = JSON.stringify(parsedBody);
    const outStructuredKeys = new Map<string, string>();

    // An unrestricted prior-step state binding whose value recurs verbatim
    // as one leaf inside the sortCriteria array — the same exclusion shape
    // a navigateTo facet literal produces, forcing the early `continue`
    // that historically skipped schema registration entirely.
    const priorStepStateBindings = new Map<string, StateVarBinding>([
      [
        "destination-hub-7731",
        {
          varName: "chainValue0",
          sourceName: "0",
          restricted: false,
          unconditional: true,
        },
      ],
    ]);

    const result = applyStructuredValuePayloadSubstitutions(
      template,
      parsedBody,
      outStructuredKeys,
      priorStepStateBindings
    );

    // The field stays excluded from the wholesale swallow — the facet
    // literal must survive untouched in the template for the downstream
    // splice pass to thread it.
    expect(result).toBe(template);
    expect(result).toContain('"destination-hub-7731"');

    // Despite being excluded from the swallow, the field's inferred schema
    // must still be registered as a structured array-of-objects type —
    // never a bare z.string() fallback.
    expect(outStructuredKeys.has("sortCriteria")).toBe(true);
    const schema = outStructuredKeys.get("sortCriteria") ?? "";
    expect(schema).toMatch(/^z\.array\(z\.object\(/);
    expect(schema).not.toBe("z.string()");
  });
});

describe("applyStructuredValuePayloadSubstitutions — schema type independent of field and body visiting order", () => {
  const withRegion = { sorts: [{ criteria: "price", order: "ASC", region: "EU" }] };
  const withoutRegion = { sorts: [{ criteria: "price", order: "ASC" }] };

  const registerAll = (bodies: Array<Record<string, unknown>>): string => {
    const out = new Map<string, string>();
    for (const body of bodies) {
      applyStructuredValuePayloadSubstitutions(JSON.stringify(body), body, out);
    }
    return out.get("sorts") ?? "";
  };

  it("registers the same z.array(z.object(...)) schema whichever body is visited first", () => {
    const forward = registerAll([withRegion, withoutRegion]);
    const reversed = registerAll([withoutRegion, withRegion]);
    expect(forward).toMatch(/^z\.array\(z\.object\(/);
    expect(forward).toBe(reversed);
    expect(forward).toContain("region");
  });

  it("registers an array schema whichever position the field has among sibling keys", () => {
    const first = { sorts: withRegion.sorts, limit: 10 };
    const last = { limit: 10, sorts: withRegion.sorts };
    expect(registerAll([first])).toMatch(/^z\.array\(z\.object\(/);
    expect(registerAll([last])).toBe(registerAll([first]));
  });
});

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const TSC_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.array-field-schema-body-type-consistency-fixture.example.com";
const LIST_URL = `https://${OWN_BACKEND_HOST}/search/results/`;
const SUBMIT_URL = `https://${OWN_BACKEND_HOST}/search/apply-sort/`;
const DESTINATION_HASH_TOKEN = "dest-hash-sort-facet-4412";
const SOURCE_ID = "urlFriendlyId";

function fixtureCaptures(): Capture[] {
  // sortCriteria recurs verbatim across two call sites (≥2 object keys,
  // ≥2 array elements each), and one element carries the navigateTo facet
  // literal suffixed by a constant delimiter — the exact exclusion shape
  // that historically skipped schema registration for the whole field.
  const sortCriteria = [
    { field: "relevance", direction: "desc" },
    { field: `${DESTINATION_HASH_TOKEN};sourceId=${SOURCE_ID}`, direction: "asc" },
  ];
  const listPage = buildCapture({
    url: LIST_URL,
    requestPostData: JSON.stringify({ sortCriteria }),
    responseBody: { ok: true },
    timestamp: "2026-04-01T00:00:00.000Z",
  });
  const submit = buildCapture({
    url: SUBMIT_URL,
    requestPostData: JSON.stringify({ sortCriteria }),
    responseBody: { ok: true },
    timestamp: "2026-04-01T00:00:01.000Z",
  });
  return [listPage, submit];
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

describe("recon-generate CLI + tsc --noEmit — array-of-objects field schema/body type consistency", () => {
  it("emits z.array(z.object(...)) for the recurring structured field and typechecks with zero diagnostics", () => {
    if (!existsSync(TSC_BIN)) {
      throw new Error("tsc not installed — cannot verify the emitted plugin compiles");
    }

    workDir = mkdtempSync(join(tmpdir(), "barnacle-array-field-schema-body-type-consistency-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `array-field-schema-body-type-consistency-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          {
            step: "navigate to search with the destination facet applied",
            navigateTo: `https://${OWN_BACKEND_HOST}/#/search/${DESTINATION_HASH_TOKEN}`,
            payloadField: "DestinationFacet",
          },
          { step: "browse search results" },
          { step: "apply sort order", submitStep: true },
        ],
        submitEndpointPattern: "search/apply-sort",
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

    // The emitted schema must declare the recurring structured field as an
    // array of objects, never a bare string fallback.
    const schemaMatch = contract.match(
      /PayloadSchema = z\.object\(\{[\s\S]*?\n\}\)(?:\.extend\(\{[\s\S]*?\n\}\))?;/
    );
    expect(schemaMatch, contract).not.toBeNull();
    const schema = schemaMatch?.[0] ?? "";
    expect(schema).toMatch(/sortCriteria:[^\n]*z\.array\(z\.object\(/);
    expect(schema).not.toMatch(/sortCriteria:\s*z\.string\(\)/);

    // Body-construction accessors indexing into sortCriteria as an array
    // (e.g. payload.sortCriteria["0"]!.field) only type-check when the
    // schema agrees it's an array of objects — tsc below is the ultimate
    // arbiter, but this is a quick, readable signal of the same invariant.
    const bodyBlocks = [...contract.matchAll(/body:\s*`([^`]*)`,/g)].map((m) => m[1] ?? "");
    expect(bodyBlocks.length, contract).toBeGreaterThan(0);

    tsconfigPath = join(
      REPO_ROOT,
      `tsconfig.array-field-schema-body-type-consistency.${process.pid}.json`
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
