import { describe, expect, it } from "vitest";

import type { ReconVocabulary } from "@/recon/vocabulary";
import {
  buildSelectOptionResolutions,
  emitMultiStepExecuteHttp,
  indexEnumEnumNamesSchemas,
  indexLabelValueOptionCodes,
} from "@/scripts/recon-generate";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Covers the dropdown label→code mechanism: real ATS bodies submit option CODES
 * (`"state":"3081"`) while the flow names LABELS (`Select 'Connecticut'`). These
 * lock the two generic label→code conventions and the per-question `id=`
 * disambiguation that bridges them — the piece that, unproven, would silently
 * submit the recon persona's frozen dropdown choices for every caller.
 */

const ENV = {} as NodeJS.ProcessEnv;

/** Minimal well-formed Capture wrapping a response body — only responseBody and
 * the structural fields the indexers read matter here. */
function capture(responseBody: unknown): Capture {
  return {
    timestamp: "2026-01-01T00:00:00Z",
    phase: "home",
    method: "GET",
    url: "https://careers.example.com/refs",
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody,
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  };
}

describe("indexEnumEnumNamesSchemas — JSON-Schema enum/enumNames convention", () => {
  it("indexes parallel enum/enumNames arrays keyed by field name", () => {
    const caps = [
      capture({
        properties: {
          disabilityStatus: {
            name: "disabilityStatus",
            enum: ["12232022", "12232023", "12232078"],
            enumNames: ["Yes", "No", "I do not wish to provide this information"],
          },
        },
      }),
    ];
    const idx = indexEnumEnumNamesSchemas(caps);
    const d = idx.get("disabilityStatus");
    expect(d).toBeDefined();
    expect(d?.codes).toEqual(["12232022", "12232023", "12232078"]);
    expect(d?.labels[1]).toBe("No");
  });

  it("keeps the entry with the most non-i18n labels when a field recurs", () => {
    // First capture: all-i18n placeholders (0 usable). Second: real labels (2 usable).
    const caps = [
      capture({ f: { name: "gender", enum: ["a", "b"], enumNames: ["{{x}}", "{{y}}"] } }),
      capture({ g: { name: "gender", enum: ["a", "b"], enumNames: ["Male", "Female"] } }),
    ];
    const idx = indexEnumEnumNamesSchemas(caps);
    expect(idx.get("gender")?.labels).toEqual(["Male", "Female"]);
  });

  it("ignores mismatched-length or non-string enum/enumNames", () => {
    const caps = [
      capture({ bad: { name: "x", enum: ["1", "2"], enumNames: ["only-one"] } }),
      capture({ bad2: { name: "y", enum: [1, 2], enumNames: ["a", "b"] } }),
    ];
    const idx = indexEnumEnumNamesSchemas(caps);
    expect(idx.has("x")).toBe(false);
    expect(idx.has("y")).toBe(false);
  });
});

describe("indexLabelValueOptionCodes — {label,value} option-object convention", () => {
  it("maps each option's label to its code", () => {
    const caps = [
      capture({
        applyGetReferences: {
          data: [
            { label: "Connecticut", value: "3081" },
            { label: "California", value: "3005" },
          ],
        },
      }),
    ];
    const idx = indexLabelValueOptionCodes(caps);
    expect(idx.get("Connecticut")).toBe("3081");
    expect(idx.get("California")).toBe("3005");
  });

  it("skips i18n-templated labels", () => {
    const caps = [capture({ opts: [{ label: "{{country.us}}", value: "1223" }] })];
    expect(indexLabelValueOptionCodes(caps).size).toBe(0);
  });

  it("documents the convention contract: keys are literally `label`/`value`", () => {
    // The indexer reads the standard `{label,value}` option shape. A `{text,id}`
    // variant is NOT indexed — this asserts the real, current contract rather
    // than a generality the implementation does not provide. If a site uses
    // other keys, its dropdowns fall through to the enum/enumNames path (keyed
    // by field name) or the unbound-literal TODO.
    const caps = [capture({ opts: [{ text: "Connecticut", id: "3081" }] })];
    expect(indexLabelValueOptionCodes(caps).size).toBe(0);
  });
});

const VOCAB: ReconVocabulary = {
  subject: /\b(the\s+)?(test\s+)?(candidate|applicant)'?s\b/i,
  exclusions: [],
  table: [
    [/\bstate\b/i, "State"],
    [/\bcountry\b/i, "Country"],
  ],
};

describe("buildSelectOptionResolutions — id= disambiguation + fallbacks", () => {
  it("resolves the SAME label to DIFFERENT codes via each step's id= hint", () => {
    const caps = [
      capture({
        s: {
          exclusion: {
            name: "applyHealthCareExclusion",
            enum: ["5394", "5395"],
            enumNames: ["Yes", "No"],
          },
          sponsorship: {
            name: "applyNeedSponsorship",
            enum: ["13054", "13055"],
            enumNames: ["Yes", "No"],
          },
        },
      }),
    ];
    const steps = [
      "Select 'No' for the healthcare exclusion question (id=applyHealthCareExclusion)",
      "Select 'No' for the sponsorship question (id=applyNeedSponsorship)",
    ];
    const { resolutions } = buildSelectOptionResolutions(steps, caps, VOCAB, ENV);
    const byKey = new Map(resolutions.map((r) => [r.wireKey, r.code]));
    // Same answer label 'No', different wire codes — the disambiguation that a
    // label-only match could never make.
    expect(byKey.get("applyHealthCareExclusion")).toBe("5395");
    expect(byKey.get("applyNeedSponsorship")).toBe("13055");
  });

  it("routes an i18n-only dropdown to the raw-code fallback, not a bogus enum", () => {
    const caps = [
      capture({
        s: {
          gender: { name: "gender", enum: ["12232011", "12232012"], enumNames: ["{{a}}", "{{b}}"] },
        },
      }),
    ];
    const steps = ["Select 'Male' in the gender dropdown (id=gender)"];
    const { resolutions, rawCodeFields } = buildSelectOptionResolutions(steps, caps, VOCAB, ENV);
    expect(resolutions.find((r) => r.wireKey === "gender")).toBeUndefined();
    const raw = rawCodeFields.get("Gender");
    expect(raw?.wireKey).toBe("gender");
    // Falls back to the last observed code as the caller-overridable default.
    expect(raw?.code).toBe("12232012");
  });

  it("resolves a no-id= state dropdown via the {label,value} fallback + vocabulary", () => {
    const caps = [capture({ data: [{ label: "Connecticut", value: "3081" }] })];
    const steps = ["Select 'Connecticut' in the State dropdown for the test candidate's state"];
    const { resolutions } = buildSelectOptionResolutions(steps, caps, VOCAB, ENV);
    const state = resolutions.find((r) => r.semanticName === "State");
    expect(state?.code).toBe("3081");
    expect(state?.label).toBe("Connecticut");
  });
});

describe("emitMultiStepExecuteHttp — dropdown code rewrite (end-to-end)", () => {
  /** One POST whose NESTED formData carries the coded slot `"state":"3081"`
   * alongside the other scalar form fields — the exact plain-JSON envelope shape
   * that the top-level key pass never reached. A realistic multi-field envelope
   * (not a lone field) so the shape-based envelope detector identifies formData
   * as the form, not as a swallowable nested structure. */
  const formData = {
    state: "3081",
    city: "Austin",
    zipCode: "06103",
    firstName: "Reginald",
    lastName: "Reconaldo",
  };
  const nestedStateBodyAction = [
    {
      capture: {
        timestamp: "2026-01-01T00:00:00Z",
        phase: "home",
        method: "POST",
        url: "https://api.example.com/applySubmit",
        status: 200,
        requestHeaders: { "Content-Type": "application/json" },
        requestPostData: JSON.stringify({ ddoKey: "applySubmit", formData }),
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

  it("rewrites a nested coded slot to an OPT lookup and registers the option field", () => {
    const outDiscoveredOptionFields = new Set<string>();
    const fieldOptionsMap = new Map();
    const resolutions = [
      {
        wireKey: "state",
        semanticName: "State",
        code: "3081",
        label: "Connecticut",
        options: [
          { label: "Connecticut", code: "3081" },
          { label: "California", code: "3005" },
        ],
      },
    ];
    const body = emitMultiStepExecuteHttp(
      nestedStateBodyAction as unknown as Parameters<typeof emitMultiStepExecuteHttp>[0],
      { ddoKey: "applySubmit", formData },
      { stringMessageKey: null, nestedErrorPaths: [] },
      new Map(),
      new Set(),
      fieldOptionsMap,
      outDiscoveredOptionFields,
      new Map(),
      new Map(),
      "https://api.example.com",
      new Map(),
      new Map(),
      null,
      new Map(),
      new Map(),
      new Set(),
      resolutions
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting emitted template-literal source
    expect(body).toContain('"state":"${OPT_State[payload.State]}"');
    expect(body).not.toContain('"state":"3081"');
    // The emitter mutates the shared maps so emitContractTs emits OPT_State + the z.enum.
    expect(outDiscoveredOptionFields.has("State")).toBe(true);
    expect(fieldOptionsMap.get("state")?.semanticName).toBe("State");
  });
});
