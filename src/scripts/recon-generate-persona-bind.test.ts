import { describe, expect, it } from "vitest";
import type { ReconVocabulary } from "@/recon/vocabulary";
import {
  deriveFillLabelField,
  emitMultiStepExecuteHttp,
  extractEntryUrlParams,
  extractStepPersonaValue,
  harvestPersonaBindings,
} from "@/scripts/recon-generate";

/**
 * These lock the value→field reconciliation the multi-step body emitter depends
 * on. The extraction rule in particular is fragile in a way unit-invisible
 * unless exercised on real instruction grammar: a possessive apostrophe in
 * "candidate's" masquerades as a quote delimiter, and a Select step names its
 * answer BEFORE the question while a Fill step names its value AFTER the label.
 * Getting either wrong silently binds the wrong (or no) string to the wire body.
 */

const ENV = { RECON_EMAIL: "cand@inbox.test" } as NodeJS.ProcessEnv;

describe("extractStepPersonaValue — verified instruction grammar", () => {
  const cases: Array<[string, string | null]> = [
    ["Fill in the First Name field with the test candidate's first name 'Reginald'", "Reginald"],
    ["Fill in the Last Name field with the test candidate's last name 'Reconaldo'", "Reconaldo"],
    ["Fill in the City field with the test candidate's city 'Austin'", "Austin"],
    [
      "Fill in the Address Line 1 field with the test candidate's street address '100 Test Street'",
      "100 Test Street",
    ],
    ["Select 'Connecticut' in the State dropdown for the test candidate's state", "Connecticut"],
    ["Select 'No' for the healthcare exclusion question (id=applyHealthCareExclusion)", "No"],
    [
      "Select 'Yes' for the 'legally authorized to work in the USA' question (id=applyLegallyAuthorizedUsa)",
      "Yes",
    ],
    ["Select 'Job Board' in the 'How did you hear about this opportunity?' dropdown", "Job Board"],
    [
      "Choose 'United States of America (+1)' in the Country Code dropdown",
      "United States of America (+1)",
    ],
    ["Click the Continue button", null],
  ];

  for (const [instruction, expected] of cases) {
    it(`extracts ${JSON.stringify(expected)} from ${JSON.stringify(instruction.slice(0, 48))}…`, () => {
      expect(extractStepPersonaValue(instruction, ENV)).toBe(expected);
    });
  }

  // Env tokens are assembled by concatenation so Biome's noTemplateCurlyInString
  // doesn't flag these literal recon-flow-file fixtures as stray template strings.
  const emailToken = `'$${"{RECON_EMAIL}"}'`;
  const phoneToken = `'$${"{RECON_PHONE}"}'`;

  it("resolves a RECON_EMAIL token to the env value regardless of quote position", () => {
    expect(extractStepPersonaValue(`Fill in the Email field with ${emailToken}`, ENV)).toBe(
      "cand@inbox.test"
    );
  });

  it("resolves an arbitrary UPPER_SNAKE env token (not just email)", () => {
    const env = { RECON_PHONE: "8605551234" } as unknown as NodeJS.ProcessEnv;
    expect(extractStepPersonaValue(`Fill in the Phone field with ${phoneToken}`, env)).toBe(
      "8605551234"
    );
  });

  it("does NOT mistake the possessive apostrophe for a quote (regression)", () => {
    // Naive /'[^']*'/ yields "s first name " here — the bug that bound zero
    // identity fields. The apostrophe-normalizing rule must return the real value.
    expect(
      extractStepPersonaValue(
        "Fill in the First Name field with the test candidate's first name 'Reginald'",
        ENV
      )
    ).toBe("Reginald");
  });
});

const VOCAB: ReconVocabulary = {
  subject: /\b(the\s+)?(test\s+)?(candidate|applicant)'?s\b/i,
  exclusions: [/signature/i],
  table: [
    [/\bfirst name\b/i, "FirstName"],
    [/\blast name\b/i, "LastName"],
    [/\b(e-?mail|personal email)\b/i, "Email"],
    [/\bcity\b/i, "City"],
    [/\b(state|province)\b/i, "State"],
  ],
};

describe("harvestPersonaBindings", () => {
  it("maps each resolved flow step's value to its payload accessor", () => {
    const steps = [
      "Fill in the First Name field with the test candidate's first name 'Reginald'",
      `Fill in the Personal Email field with '$${"{RECON_EMAIL}"}'`,
      "Select 'Connecticut' in the State dropdown for the test candidate's state",
      "Click the Continue button",
    ];
    const bindings = harvestPersonaBindings(steps, VOCAB, ENV);
    expect(bindings.get("Reginald")).toBe("payload.FirstName");
    expect(bindings.get("cand@inbox.test")).toBe("payload.Email");
    expect(bindings.get("Connecticut")).toBe("payload.State");
    // The Continue step resolves to no field, so it contributes no binding.
    expect(bindings.size).toBe(3);
  });

  it("derives the field from the fill label when the vocabulary has no match", () => {
    // With an empty vocabulary, `resolveStepPayloadField` returns null — but a
    // `fill in the <LABEL> field with '<value>'` step is self-describing, so the
    // label-derivation fallback still binds it (the fix for vocab-miss fields
    // like a "middle name" the consumer vocab forgot to list).
    const empty: ReconVocabulary = { subject: /(?!)/, exclusions: [], table: [] };
    const steps = ["Fill in the First Name field with the test candidate's first name 'Reginald'"];
    const bindings = harvestPersonaBindings(steps, empty, ENV);
    expect(bindings.get("Reginald")).toBe("payload.FirstName");
  });

  it("does not derive a field for a Select step under an empty vocabulary", () => {
    // Select/Choose stay vocabulary-gated: they name the answer first and often
    // a mere facet second, so label-derivation there would false-splice.
    const empty: ReconVocabulary = { subject: /(?!)/, exclusions: [], table: [] };
    const steps = ["Select 'No' for the sponsorship question"];
    expect(harvestPersonaBindings(steps, empty, ENV).size).toBe(0);
  });

  it("keeps the earliest step on a duplicate value", () => {
    const steps = [
      "Fill in the City field with the test candidate's city 'Austin'",
      "Fill in the City field for the work experience entry with 'Austin'",
    ];
    const bindings = harvestPersonaBindings(steps, VOCAB, ENV);
    expect(bindings.get("Austin")).toBe("payload.City");
  });

  it("lets the vocabulary win over label-derivation when both would resolve", () => {
    // The vocab maps "personal email" → Email; label-derivation would produce
    // PersonalEmail. Vocab must win, so a vocab-recognized fill step is never
    // overridden by the fallback.
    const steps = [`Fill in the Personal Email field with '$${"{RECON_EMAIL}"}'`];
    const bindings = harvestPersonaBindings(steps, VOCAB, ENV);
    expect(bindings.get("cand@inbox.test")).toBe("payload.Email");
  });

  it("respects vocabulary exclusions even for label-derivable fill steps", () => {
    // The signature-block first name is excluded; the fill-grammar still matches,
    // but an excluded step must not resurface via label-derivation.
    const empty: ReconVocabulary = { subject: /(?!)/, exclusions: [/signature/i], table: [] };
    const steps = ["Fill in the First Name field in the signature block with 'Reginald'"];
    expect(harvestPersonaBindings(steps, empty, ENV).size).toBe(0);
  });

  it("honors an explicit payloadFieldNone opt-out over label-derivation", () => {
    const empty: ReconVocabulary = { subject: /(?!)/, exclusions: [], table: [] };
    const steps = [
      { step: "Fill in the Middle Name field with 'Quentin'", payloadFieldNone: true },
    ];
    expect(harvestPersonaBindings(steps, empty, ENV).size).toBe(0);
  });

  it("binds a vocab-miss identity field (middle name) via the fill label", () => {
    // The report's defect #2: a "middle name" step the recruiting vocab forgot.
    const steps = [
      "Fill in the First Name field with the test candidate's first name 'Reginald'",
      "Fill in the Middle Name field with 'Quentin'",
    ];
    const bindings = harvestPersonaBindings(steps, VOCAB, ENV);
    expect(bindings.get("Reginald")).toBe("payload.FirstName");
    expect(bindings.get("Quentin")).toBe("payload.MiddleName");
  });
});

describe("deriveFillLabelField — self-describing fill/enter/type grammar", () => {
  const cases: Array<[string, string | null]> = [
    ["Fill in the Middle Name field with 'Quentin'", "MiddleName"],
    ["Fill in the Address Line 1 field with '100 Main'", "AddressLine1"],
    ["Enter the Date of Birth field with '1990-01-01'", "DateOfBirth"],
    ["Type in the Preferred Name field with 'Q'", "PreferredName"],
    // Select/Choose are excluded — they name the answer first, not the field.
    ["Select 'No' for the sponsorship question", null],
    ["Choose 'United States' in the Country dropdown", null],
    // No quoted constant → nothing to bind.
    ["Fill in the Middle Name field", null],
    // Not a fill/enter/type instruction.
    ["Click the Continue button", null],
  ];
  for (const [instruction, expected] of cases) {
    it(`derives ${JSON.stringify(expected)} from ${JSON.stringify(instruction.slice(0, 42))}…`, () => {
      expect(deriveFillLabelField(instruction)).toBe(expected);
    });
  }
});

describe("extractEntryUrlParams — job coordinates from the entry URL", () => {
  it("maps each long query-param value to its payload accessor", () => {
    const params = extractEntryUrlParams(
      "https://careers.example.com/us/en/apply?jobSeqNo=ABC123456EXTERNAL&step=1"
    );
    expect(params.get("ABC123456EXTERNAL")).toBe("payload.jobSeqNo");
    // `step=1` is below the length floor — skipped, not a stray payload field.
    expect([...params.values()]).not.toContain("payload.step");
  });

  it("returns an empty map for a URL with no query string", () => {
    expect(extractEntryUrlParams("https://careers.example.com/apply").size).toBe(0);
  });

  it("returns an empty map for an unparseable URL", () => {
    expect(extractEntryUrlParams("not a url").size).toBe(0);
  });
});

describe("persona binding — short-value substring-corruption guard", () => {
  // `inputBody` is passed as `null` so the first-body payload-accessor pass and
  // the top-level key-value pass never fire — isolating the persona merge as the
  // ONLY thing that could touch these values.
  function emitNoInputBody(body: unknown, personaBindings: Map<string, string>): string {
    const action = [
      {
        capture: {
          timestamp: "2026-01-01T00:00:00Z",
          phase: "home",
          method: "POST",
          url: "https://api.example.com/submit",
          status: 200,
          requestHeaders: { "Content-Type": "application/json" },
          requestPostData: JSON.stringify(body),
          responseHeaders: {},
          responseBody: { ok: true },
          operationName: null,
          query: null,
          variables: null,
          decodedParams: null,
        },
        varName: "r0",
        produces: [],
        isMultipart: false,
        isCrossDomain: false,
      },
    ];
    return emitMultiStepExecuteHttp(
      action as unknown as Parameters<typeof emitMultiStepExecuteHttp>[0],
      null,
      { stringMessageKey: null, nestedErrorPaths: [] },
      new Map(),
      new Set(),
      new Map(),
      new Set(),
      new Map(),
      new Map(),
      "https://api.example.com",
      new Map(),
      new Map(),
      null,
      personaBindings
    );
  }

  it("does NOT let a sub-floor persona value (e.g. 'No') corrupt a nested substring", () => {
    // "No" (2 chars) is below MIN_STATE_VALUE_LENGTH. The unanchored split would
    // otherwise rewrite the "No" inside "Nursing role". The length gate drops the
    // binding, so the nested value survives intact.
    const body = emitNoInputBody(
      { form: { note: "Nursing role" } },
      new Map([["No", "payload.Answer"]])
    );
    expect(body).toContain("Nursing role");
    expect(body).not.toContain("payload.Answer");
  });

  it("binds a persona value at any depth when it sits at token boundaries", () => {
    // "Connecticut" appears only as a whole quoted value → binds via the persona
    // merge alone (inputBody is null, so no other pass could).
    const body = emitNoInputBody(
      { form: { state: "Connecticut" } },
      new Map([["Connecticut", "payload.State"]])
    );
    expect(body).toContain("payload.State");
    expect(body).not.toContain('"state":"Connecticut"');
  });

  it("binds a value that ALSO appears space-delimited inside a composite (e.g. a signature)", () => {
    // "Reginald" occurs both standalone and inside "Reginald Reconaldo" — the
    // space is a token boundary, so it is NOT a mangling collision; both slots
    // legitimately take the caller's value. The word-boundary guard must allow it.
    const body = emitNoInputBody(
      { first: "Reginald", signature: "Reginald Reconaldo" },
      new Map([["Reginald", "payload.FirstName"]])
    );
    expect(body).toContain("payload.FirstName");
    expect(body).not.toContain('"first":"Reginald"');
    // The signature slot binds too — the caller's name reaches the composite.
    expect(body).toContain("payload.FirstName} Reconaldo");
  });
});
