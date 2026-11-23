import { describe, expect, it } from "vitest";
import { emitContractTs } from "@/scripts/recon-generate";

const BASE_OPTS = {
  siteId: "test-site",
  pascal: "TestSite",
  baseUrl: "https://example.com",
  baseHeaders: {},
  minTime: 100,
  safeRps: 10,
  responseBody: { ok: true },
  gql: false,
  gqlQuery: null,
  endpointPath: "/api/example",
  auxFiles: [],
};

const emit = (extra: object) => emitContractTs({ ...BASE_OPTS, ...extra } as never);

describe("emitContractTs — extraPayloadFields", () => {
  it("emits declared fields with type and optionality", () => {
    const c = emit({
      extraPayloadFields: [
        { name: "Nick", type: "string" },
        { name: "Age", type: "number", optional: true },
        { name: "Agree", type: "boolean" },
      ],
    });
    expect(c).toContain("  Nick: z.string(),");
    expect(c).toContain("  Age: z.number().optional(),");
    expect(c).toContain("  Agree: z.boolean(),");
  });

  it("does not duplicate a field discovered from captures", () => {
    const c = emit({
      discoveredFormFields: new Set(["Nick"]),
      extraPayloadFields: [{ name: "Nick", type: "string" }],
    });
    expect(c.match(/^ {2}Nick:/gm)?.length).toBe(1);
  });

  it("is a no-op without declared fields", () => {
    expect(emit({ extraPayloadFields: [] })).toBe(emit({}));
  });
});

describe("emitContractTs — meta.redaction", () => {
  it("emits word/digit keys by declared kind", () => {
    const c = emit({
      extraPayloadFields: [
        { name: "Nick", type: "string", sensitive: true },
        { name: "Phone", type: "string", sensitive: true, redactionKind: "digit" },
        { name: "Plain", type: "string" },
      ],
    });
    expect(c).toContain('redaction: {"wordKeys":["Nick"],"digitKeys":["Phone"]},');
  });

  it("emits no redaction when nothing is sensitive", () => {
    expect(emit({ extraPayloadFields: [{ name: "A", type: "string" }] })).not.toContain(
      "redaction:"
    );
  });
});
