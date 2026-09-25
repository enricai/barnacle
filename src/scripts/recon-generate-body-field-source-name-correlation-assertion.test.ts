import { describe, expect, it } from "vitest";
import {
  assertBodyFieldSourceNameCorrelates,
  compileActionSteps,
  emitMultiStepExecuteHttp,
  extractGraphQLActionSequence,
  indexStateValues,
} from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

const BASE = "https://api.example.com";

/**
 * Universal generation-time safety net (recon-generate.ts's
 * `assertBodyFieldSourceNameCorrelates`, modeled after the existing
 * `assertNoFrozenVaryingDrillParams` structural gate): whenever a fold/drill
 * per-item or ancestor-scope field is spliced under a JSON body key whose
 * own name doesn't plausibly correlate with the field's own name, generation
 * must fail loudly rather than silently ship a body field assigned from an
 * unrelated source — regardless of which of this file's several independent
 * threading mechanisms (fold-item join fields, ancestor-scope rebinding,
 * drill-param binding, ...) produced the splice.
 */
describe("assertBodyFieldSourceNameCorrelates", () => {
  it("throws when a spliced item field's own name doesn't correlate with the JSON key it lands under", () => {
    const renderedBody = [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal text representing generated code, not a template literal to evaluate
      "const r1 = await httpClient(`${payload.BaseUrl}/status`, {",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal text representing generated code, not a template literal to evaluate
      '  body: `{"orderId":"${item.orderId}","region":${item.warehouseZone}}`,',
      "});",
    ].join("\n");
    expect(() =>
      assertBodyFieldSourceNameCorrelates("emitMultiStepExecuteHttp", renderedBody)
    ).toThrow(/body field "region" is spliced from "\$\{item\.warehouseZone\}".*doesn't correlate/);
  });

  it("throws for an ancestor-scoped (`gN.`) splice whose own name doesn't correlate with the key", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal text representing generated code, not a template literal to evaluate
    const renderedBody = 'body: `{"currency":${g0.accountRegionCode}}`,';
    expect(() =>
      assertBodyFieldSourceNameCorrelates("emitMultiStepExecuteHttp", renderedBody)
    ).toThrow(/"currency".*"\$\{g0\.accountRegionCode\}"/);
  });

  it("throws for an ancestor splice in the emitter's cast form — the wrapper is spelling, not a different accessor", () => {
    const renderedBody =
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal text representing generated code, not a template literal to evaluate
      'body: `{"currency":${(g0 as Record<string, unknown>).accountRegionCode}}`,';
    expect(() =>
      assertBodyFieldSourceNameCorrelates("emitMultiStepExecuteHttp", renderedBody)
    ).toThrow(/"currency".*accountRegionCode/);
  });

  it("throws for a nested cast-form ancestor splice whose leaf name doesn't correlate", () => {
    const renderedBody =
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal text representing generated code, not a template literal to evaluate
      'body: `{"currency":"${((g1 as Record<string, unknown>).meta as Record<string, unknown>).regionCode}"}`,';
    expect(() =>
      assertBodyFieldSourceNameCorrelates("emitMultiStepExecuteHttp", renderedBody)
    ).toThrow(/"currency".*regionCode/);
  });

  it("stays silent for a nested cast-form ancestor splice whose leaf name correlates", () => {
    const renderedBody =
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal text representing generated code, not a template literal to evaluate
      'body: `{"currency":"${((g1 as Record<string, unknown>).priceSummary as Record<string, unknown>).currency}"}`,';
    expect(() =>
      assertBodyFieldSourceNameCorrelates("emitMultiStepExecuteHttp", renderedBody)
    ).not.toThrow();
  });

  it("throws for a nested cast-form item splice whose leaf name doesn't correlate", () => {
    const renderedBody =
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal text representing generated code, not a template literal to evaluate
      'body: `{"region":${(item.identifiers as Record<string, unknown>).sku}}`,';
    expect(() =>
      assertBodyFieldSourceNameCorrelates("emitMultiStepExecuteHttp", renderedBody)
    ).toThrow(/"region".*sku/);
  });

  it("stays silent when the item field's own name correlates with the JSON key (exact match)", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal text representing generated code, not a template literal to evaluate
    const renderedBody = 'body: `{"orderId":"${item.orderId}"}`,';
    expect(() =>
      assertBodyFieldSourceNameCorrelates("emitMultiStepExecuteHttp", renderedBody)
    ).not.toThrow();
  });

  it("stays silent when the item field's own name correlates with the JSON key (compound match)", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal text representing generated code, not a template literal to evaluate
    const renderedBody = 'body: `{"accountId":"${g1.applicationAccountId}"}`,';
    expect(() =>
      assertBodyFieldSourceNameCorrelates("emitMultiStepExecuteHttp", renderedBody)
    ).not.toThrow();
  });

  it("stays silent for a `payload.<field>` accessor regardless of key name — matches by definition", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal text representing generated code, not a template literal to evaluate
    const renderedBody = 'body: `{"adultCount":${payload.numberOfGuests}}`,';
    expect(() =>
      assertBodyFieldSourceNameCorrelates("emitMultiStepExecuteHttp", renderedBody)
    ).not.toThrow();
  });

  it("stays silent for a bare array index/counter — names a position, not a concept", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal text representing generated code, not a template literal to evaluate
    const renderedBody = 'body: `{"childCount":${i}}`,';
    expect(() =>
      assertBodyFieldSourceNameCorrelates("emitMultiStepExecuteHttp", renderedBody)
    ).not.toThrow();
  });

  it("stays silent for a top-level chain-produced value (`token`) threaded by exact value identity, not name", () => {
    // Not fold/drill-scoped (no `item`/`gN` root) — this is the separate,
    // already value-gated whole-value substitution mechanism (see
    // recon-generate-biome-clean.test.ts's Bug B fixture, `token` -> `auth`),
    // which legitimately allows a differently-named target key.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal text representing generated code, not a template literal to evaluate
    const renderedBody = 'body: `{"auth":${token}}`,';
    expect(() =>
      assertBodyFieldSourceNameCorrelates("emitMultiStepExecuteHttp", renderedBody)
    ).not.toThrow();
  });
});

/**
 * Full-pipeline regression guard: the existing drilldown-fold e2e suite
 * (covered wholesale by `pnpm test`) already proves this net stays silent
 * across every currently-passing fold/drill-threading fixture; this adds one
 * direct pipeline-level case built the same way those fixtures are, so a
 * regression here is caught by name instead of only by the suite-wide count.
 */
describe("emitMultiStepExecuteHttp — universal body-field/source-name correlation assertion (pipeline)", () => {
  function searchCapture(): unknown {
    return buildCapture({
      method: "POST",
      url: `${BASE}/orders/search`,
      requestPostData: JSON.stringify({ page: 1 }),
      responseBody: {
        results: [
          { orderId: "order-a", region: "NE01" },
          { orderId: "order-b", region: "SW02" },
        ],
      },
      timestamp: "2024-01-01T00:00:00Z",
    });
  }

  function drillCapture(orderId: string, region: string, ts: string): unknown {
    return buildCapture({
      method: "POST",
      url: `${BASE}/orders/status?region=${region}`,
      requestPostData: JSON.stringify({ orderId }),
      responseBody: { status: "shipped" },
      timestamp: ts,
    });
  }

  function buildActionSteps(captures: unknown[]): ReturnType<typeof compileActionSteps> {
    const actionCaptures = extractGraphQLActionSequence(captures as never[], null, null);
    const stateIndex = indexStateValues(captures as never[]);
    return compileActionSteps(actionCaptures, stateIndex);
  }

  function emit(actionSteps: ReturnType<typeof compileActionSteps>): string {
    const primary = searchCapture() as { requestPostData: string | null };
    return emitMultiStepExecuteHttp(
      actionSteps as unknown as Parameters<typeof emitMultiStepExecuteHttp>[0],
      JSON.parse(primary.requestPostData ?? "null"),
      { stringMessageKey: null, nestedErrorPaths: [] },
      new Map(),
      new Set(),
      new Map(),
      new Set(),
      new Map(),
      new Map(),
      BASE,
      new Map(),
      new Map()
    );
  }

  it("stays silent for a genuinely name-correlated item-field drill threading", () => {
    const actionSteps = buildActionSteps([
      searchCapture(),
      drillCapture("order-a", "NE01", "2024-01-01T00:00:01Z"),
      drillCapture("order-b", "SW02", "2024-01-01T00:00:02Z"),
    ]);
    expect(() => emit(actionSteps)).not.toThrow();
  });
});
