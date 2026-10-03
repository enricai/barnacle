import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Covers the report's exact observed shape: a single-observed top-level
 * array-of-objects field (recon never saw it vary, unlike the DIFFERENT-per-
 * capture fixture already covered by
 * recon-generate-1-12-75-array-object-toplevel-facet-discovery-e2e.test.ts)
 * sitting beside an array-of-strings field that is already known to thread
 * correctly. A prior step's response produces a RESTRICTED, name-correlated
 * value ("venueLabel", genuinely reused downstream under the correlating
 * "venue" field) whose own value coincidentally equals one leaf
 * ("reference") inside the composite field — the exact shape
 * applyStructuredValuePayloadSubstitutionsForEnvelope used to exclude the
 * WHOLE composite field over, pre-fix, with no check that "reference" and
 * "venueLabel" name the same concept. Both the composite field and its
 * array-of-strings sibling must be declared on PayloadSchema and spliced as
 * `${JSON.stringify(payload.<field>)}`, not frozen as a literal.
 */

const REPO_ROOT = join(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const GENERATE_SCRIPT = join(REPO_ROOT, "src", "scripts", "recon-generate.ts");

const OWN_BACKEND_HOST = "www.single-capture-composite-field-threading-fixture.example.com";

// Kept >= recon-generate's state-value length floor so it is indexed on its
// own merits (no chain/force-include short-value exemption involved).
const VENUE_LABEL_VALUE = "zone-7781-hall";

// The same composite value on every capture — recon never observes it vary.
// Its "reference" leaf deliberately coincides with an unrelated prior step's
// RESTRICTED "venueLabel" value below; the names do not correlate.
const ATTENDEE_SLOTS = [
  { category: "STANDARD", reference: VENUE_LABEL_VALUE },
  { category: "PREMIUM", reference: "unrelated-ref-9f3c" },
];
// Known-working sibling: a plain array of strings, unchanged across captures.
const TAGS = ["early-bird", "waitlist-eligible"];

function fixtureCaptures(): Capture[] {
  const browse = buildCapture({
    url: `https://${OWN_BACKEND_HOST}/booking/browse/`,
    requestPostData: '{"page":1}',
    responseBody: { results: [{ eventId: "event-a" }] },
    timestamp: "2026-03-01T00:00:00.000Z",
  });
  const detail = buildCapture({
    url: `https://${OWN_BACKEND_HOST}/booking/detail/`,
    requestPostData: '{"eventId":"event-a"}',
    // Produces a RESTRICTED, name-correlated value ("venueLabel") — genuinely
    // reused downstream under the correlating "venue" field — whose own
    // value also coincidentally equals the submit body's unrelated
    // "reference" leaf inside attendeeSlots.
    responseBody: { eventId: "event-a", venueLabel: VENUE_LABEL_VALUE },
    timestamp: "2026-03-01T00:00:01.000Z",
  });
  const checkout = buildCapture({
    url: `https://${OWN_BACKEND_HOST}/booking/checkout/`,
    requestPostData: JSON.stringify({
      eventId: "event-a",
      venue: VENUE_LABEL_VALUE,
      attendeeSlots: ATTENDEE_SLOTS,
      tags: TAGS,
    }),
    responseBody: { ok: true },
    timestamp: "2026-03-01T00:00:02.000Z",
  });
  return [browse, detail, checkout];
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

describe("recon-generate CLI — single-observed top-level array-of-objects field threaded alongside a known-working array-of-strings field", () => {
  it("declares attendeeSlots on PayloadSchema and splices payload.attendeeSlots instead of freezing the only-ever-observed literal", () => {
    workDir = mkdtempSync(join(tmpdir(), "barnacle-single-capture-composite-field-threading-"));
    const runRoot = join(workDir, "run");
    writeRunDir(runRoot, fixtureCaptures());

    const siteId = `single-capture-composite-field-threading-test-${process.pid}`;
    siteOutDir = join(REPO_ROOT, "src", "sites", siteId);
    mkdirSync(siteOutDir, { recursive: true });
    writeFileSync(
      join(siteOutDir, "recon-flow.json"),
      JSON.stringify({
        steps: [
          { step: "browse events" },
          { step: "open event detail panel" },
          { step: "checkout", submitStep: true },
        ],
        submitEndpointPattern: "booking/checkout",
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
    const expectedCompositeSub = "${JSON.stringify(payload.attendeeSlots)}";
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
    const expectedTagsSub = "${JSON.stringify(payload.tags)}";
    expect(contract).toContain(`"attendeeSlots":${expectedCompositeSub}`);
    expect(contract).toContain(`"tags":${expectedTagsSub}`);

    // The single-observed composite literal must never survive frozen in any
    // body template — observing it only once must not be mistaken for it
    // being constant.
    const bodyTemplates = [...contract.matchAll(/body:\s*`([\s\S]*?)`/g)].map((m) => m[1] ?? "");
    expect(bodyTemplates.length).toBeGreaterThan(0);
    for (const body of bodyTemplates) {
      expect(body).not.toContain(JSON.stringify(ATTENDEE_SLOTS));
      expect(body).not.toContain('"category":"STANDARD"');
    }

    // PayloadSchema declares both fields as required array fields.
    const schemaMatch = contract.match(
      /PayloadSchema = z\.object\(\{[\s\S]*?\n\}\)(?:\.extend\(\{[\s\S]*?\n\}\))?;/
    );
    expect(schemaMatch, contract).not.toBeNull();
    const schema = schemaMatch?.[0] ?? "";

    const attendeeSlotsFieldMatch = schema.match(/ {2}attendeeSlots:[\s\S]*?\n {2}\S/);
    expect(attendeeSlotsFieldMatch, schema).not.toBeNull();
    const attendeeSlotsField = attendeeSlotsFieldMatch![0]!;
    expect(attendeeSlotsField).toMatch(/z\.array/);
    expect(attendeeSlotsField).not.toMatch(/\.optional\(\)/);

    const tagsFieldMatch = schema.match(/ {2}tags:[\s\S]*?\n(?: {2}\S|\}\))/);
    expect(tagsFieldMatch, schema).not.toBeNull();
    const tagsField = tagsFieldMatch![0]!;
    expect(tagsField).toMatch(/z\.array/);
    expect(tagsField).not.toMatch(/\.optional\(\)/);
  }, 30_000);
});
