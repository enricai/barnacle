import { describe, expect, it } from "vitest";
import shippedSteps from "@/recon/fixtures/shipped-ats-flow-steps.json";
import type { ReconVocabulary } from "@/recon/vocabulary";
import { resolveStepPayloadField } from "@/scripts/recon-generate";

/**
 * A FROZEN GOLDEN COPY of the recruiting vocabulary, not a live import of the
 * consumer's preset — barnacle cannot depend on autoapply, so parity is measured
 * out-of-band (both yield 65/65 over the fixture below).
 *
 * The freeze is the point: this pins the splice behaviour the three shipped ATS
 * plugins were generated against, so an engine change that moves it fails here.
 * It does NOT detect drift in autoapply's own preset — if that file changes, this
 * keeps passing while asserting nothing about production. At 2.0.0 the built-in
 * table is deleted and this becomes the last copy in the engine; re-measure parity
 * against autoapply then rather than trusting this to track it.
 */
const ATS_VOCABULARY: ReconVocabulary = {
  subject: /\b(the\s+)?(test\s+)?(candidate|applicant)'?s\b/i,
  exclusions: [
    /reference\s*#?\s*\d/i,
    /employment history/i,
    /\bcompany (name|phone)\b/i,
    /\bemployer\b/i,
    /signature/i,
    /\bfull name\b/i,
    /today'?s date/i,
    /school|institution|degree|major|education/i,
    /^\s*for\s+'/i,
    /\bquestion\b/i,
    /\bsecondary\b[^.]*\bphone\b/i,
  ],
  table: [
    [/\bfirst name\b/i, "FirstName"],
    [/\blast name\b/i, "LastName"],
    [/\b(e-?mail|email address)\b/i, "Email"],
    [/\b(mobile phone|primary phone|phone number|mobile)\b/i, "MobilePhone"],
    [/\b(street address|address line 1)\b/i, "AddressLine1"],
    [/\bcity\b/i, "City"],
    [/\b(state|province|state\/region)\b/i, "State"],
    [/\b(zip|postal)\b/i, "PostalCode"],
    [/\bcountry\b/i, "Country"],
  ],
};

interface ShippedStep {
  site: string;
  instruction: string;
  payloadField?: string;
  payloadFieldNone?: boolean;
}

/**
 * Replays every step of three representative shipped ATS flow shapes through the
 * splice resolver.
 *
 * This is the gate the 21 hand-written unit tests are not: it runs on real
 * production flow shapes. An earlier attempt to "simplify" the dropdown clause
 * passed all 21 unit tests and would still have silently dropped the caller's
 * state and country on every apply through the JSON-envelope flow — this replay is
 * what caught it. The fixture is distilled from a consumer's recon-flow.json files
 * and anonymized (site ids, employer names, and the recon persona are synthetic),
 * so the check is reproducible in CI without that repo checked out. Anonymization
 * is resolver-neutral by construction: the vocabulary below matches field LABELS,
 * never proper nouns, so renaming employers cannot move a splice decision.
 */
describe("shipped ATS flows — splice replay", () => {
  const steps = shippedSteps as ShippedStep[];

  const resolved = steps.map((s) => ({
    ...s,
    field: resolveStepPayloadField(
      s.instruction,
      s.payloadField,
      s.payloadFieldNone,
      ATS_VOCABULARY
    ),
  }));

  it("covers all 429 shipped steps", () => {
    expect(steps).toHaveLength(429);
  });

  it("splices exactly 65 steps — no silent regression", () => {
    expect(resolved.filter((r) => r.field !== null)).toHaveLength(65);
  });

  it("keeps the two dropdown steps that carry no quoted constant", () => {
    // These splice ONLY via the subject-scoped dropdown clause — they carry no
    // quoted constant for the label table to match. Deleting that clause drops the
    // caller's state/country on every apply, and no unit test notices.
    const state = resolved.find((r) =>
      r.instruction.startsWith("If a State or Province dropdown is visible")
    );
    const country = resolved.find((r) =>
      r.instruction.startsWith("If a Country dropdown is visible")
    );
    expect(state?.field).toBe("State");
    expect(country?.field).toBe("Country");
  });

  it("never splices a screening question", () => {
    const questions = resolved.filter((r) => /^\s*For\s+'/i.test(r.instruction));
    expect(questions.length).toBeGreaterThan(0);
    for (const q of questions) expect(q.field).toBeNull();
  });
});
