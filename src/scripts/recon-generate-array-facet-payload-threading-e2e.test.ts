import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * End-to-end proof, through the real CLI, for Finding 1's array-facet half:
 * a typed array-of-objects payload field (structurally identical to the
 * reported `partyMix` — an array of `{count, subCount, ages, id}`-shaped
 * records) must get spliced into EVERY request body it appears in as
 * `${JSON.stringify(payload.<field>)}`, never survive as a frozen literal.
 * Distinct from `recon-generate-structured-value-array-body.test.ts`, which
 * only proves `applyStructuredValuePayloadSubstitutions` in isolation — this
 * proves the same field also survives the full per-capture body pipeline
 * (form subs, facet splice, state threading, url-param binding) when it
 * recurs, byte-for-byte, across six separate request bodies in one flow.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.array-facet-payload-threading-fixture.example.com";

// The captured JSON literal repeated verbatim across all six request
// bodies, mirroring the finding's own partyMix repro shape.
const ATTENDEE_MIX = [{ adultCount: 2, childCount: 0, subAges: [], mixId: "0" }];
const ATTENDEE_MIX_JSON = JSON.stringify(ATTENDEE_MIX);

function bodyWithAttendeeMix(extra: Record<string, unknown>): string {
  return JSON.stringify({ ...extra, attendeeMix: ATTENDEE_MIX });
}

function fixtureCaptures(): Capture[] {
  const urls = [
    `https://${OWN_BACKEND_HOST}/catalog/search/`,
    `https://${OWN_BACKEND_HOST}/catalog/filter/`,
    `https://${OWN_BACKEND_HOST}/catalog/itinerary/`,
    `https://${OWN_BACKEND_HOST}/catalog/cabin/`,
    `https://${OWN_BACKEND_HOST}/catalog/pricing/`,
    `https://${OWN_BACKEND_HOST}/catalog/submit/`,
  ];
  return urls.map((url, index) =>
    buildCapture({
      url,
      requestPostData: bodyWithAttendeeMix({ step: index }),
      responseBody: { ok: true, index },
      timestamp: `2026-01-01T00:00:0${index}.000Z`,
    })
  );
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

describe("recon-generate CLI — typed array-of-objects facet field threaded into every request body", () => {
  it("splices JSON.stringify(payload.attendeeMix) into all six request bodies instead of freezing the captured literal", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-array-facet-payload-threading-e2e-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `array-facet-payload-threading-e2e-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "browse catalog search" },
          { step: "apply catalog filters" },
          { step: "select itinerary" },
          { step: "select cabin" },
          { step: "review pricing" },
          { step: "submit booking", submitStep: true },
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

    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    const expectedSub = "${JSON.stringify(payload.attendeeMix)}";
    expect(contract).toContain(`"attendeeMix":${expectedSub}`);

    // Every occurrence must be rewritten — a frozen literal for even one
    // call site would silently submit a stale, capture-time party mix.
    const spliceCount = contract.split(`"attendeeMix":${expectedSub}`).length - 1;
    expect(spliceCount).toBe(6);

    // The captured literal itself must never survive inside any body:
    // template literal — grepping for its raw JSON text (once escaped for
    // an embedding template literal) must return zero matches.
    const bodyTemplates = [...contract.matchAll(/body:\s*`([\s\S]*?)`/g)].map((m) => m[1] ?? "");
    expect(bodyTemplates.length).toBeGreaterThan(0);
    for (const body of bodyTemplates) {
      expect(body).not.toContain('"adultCount":2');
      expect(body).not.toContain(ATTENDEE_MIX_JSON);
    }

    // The payload schema declares attendeeMix as a required (non-optional)
    // array field, not merely a string passthrough.
    const schemaMatch = contract.match(
      /PayloadSchema = z\.object\(\{[\s\S]*?\n\}\)(?:\.extend\(\{[\s\S]*?\n\}\))?;/
    );
    expect(schemaMatch, contract).not.toBeNull();
    const schema = schemaMatch?.[0] ?? "";
    const attendeeMixFieldMatch = schema.match(/ {2}attendeeMix:[\s\S]*?\n {2}\S/);
    expect(attendeeMixFieldMatch, schema).not.toBeNull();
    const attendeeMixField = attendeeMixFieldMatch![0]!;
    expect(attendeeMixField).toMatch(/z\.array/);
    expect(attendeeMixField).not.toMatch(/\.optional\(\)/);
  }, 30_000);
});
