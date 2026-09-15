import { describe, expect, it } from "vitest";
import { emitContractTs } from "@/scripts/recon-generate";

/**
 * Pins the structural fix for the schema/body-emission disagreement
 * (TS2339/TS7053/TS18046 on regenerated contract.ts): field registration for
 * the caller-facing payload schema used to be done ad hoc across many
 * independent substitution passes (form-schema discovery, option mappings,
 * additional-body-key discovery, structured-key discovery, drill-param
 * bindings, ...), each of which must individually remember to register every
 * field it introduces. Any one of those passes forgetting to register a
 * field it spliced into the rendered body — the fold-loop's per-item body
 * rewrite being one confirmed source — leaves the schema and the body
 * disagreeing about the payload's own shape.
 *
 * Rather than trust every future field source to stay in sync with its own
 * registration bookkeeping, emitContractTs now derives schema completeness
 * from the single source of truth that actually matters: the fully-rendered
 * `multiStepBody` text itself. This test drives emitContractTs directly with
 * a synthetic `multiStepBody` that references a `payload.<field>` accessor
 * no discovered-field source declares, proving the safety net closes the gap
 * regardless of which upstream pass would have missed it.
 */
describe("emitContractTs — payload schema always declares every payload.<field> the emitted body references", () => {
  it("adds a field discovered only from the rendered multiStepBody text, not from any of the other discovered-field sources", () => {
    const source = emitContractTs({
      siteId: "test-site",
      pascal: "TestSite",
      baseUrl: "https://api.example.com",
      baseHeaders: { "Content-Type": "application/json" },
      minTime: 100,
      safeRps: 10,
      responseBody: { ok: true },
      gql: false,
      gqlQuery: null,
      endpointPath: "/catalog/drill",
      auxFiles: [],
      isSubmissionFlow: true,
      inputBody: { itemId: "item-a" },
      multiStepBody: [
        "    for (const g0 of (r0 as { items: unknown[] }).items) {",
        "      const r1 = (await httpClient(`https://api.example.com/catalog/drill?region=${payload.region}`, {",
        '        method: "GET",',
        "        schema: z.unknown(),",
        "      })) as Record<string, unknown>;",
        "    }",
        "    return { data: r0 };",
      ].join("\n"),
      // Deliberately empty/undefined: none of the other discovered-field
      // sources know about `region` — it must only be found by scanning
      // multiStepBody itself.
      discoveredFormFields: new Set(),
      discoveredAdditionalBodyKeys: new Map(),
      discoveredStructuredKeys: new Map(),
      discoveredRawOptionFields: new Map(),
      payloadFieldNames: new Set(),
    });

    expect(source).toContain("region: z.string(),");
  });

  it("does not double-declare a field that another source already registered with its own (non-string) type", () => {
    const source = emitContractTs({
      siteId: "test-site",
      pascal: "TestSite",
      baseUrl: "https://api.example.com",
      baseHeaders: { "Content-Type": "application/json" },
      minTime: 100,
      safeRps: 10,
      responseBody: { ok: true },
      gql: false,
      gqlQuery: null,
      endpointPath: "/catalog/drill",
      auxFiles: [],
      isSubmissionFlow: true,
      inputBody: { itemId: "item-a" },
      multiStepBody: [
        "    const r1 = (await httpClient(`https://api.example.com/catalog/drill?page=${payload.page}`, {",
        '      method: "GET",',
        "      schema: z.unknown(),",
        "    })) as Record<string, unknown>;",
        "    return { data: r0 };",
      ].join("\n"),
      discoveredAdditionalBodyKeys: new Map([["page", "number"]]),
    });

    expect(source).toContain("page: z.number(),");
    expect(source).not.toContain("page: z.string(),");
  });
});
