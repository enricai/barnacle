import { describe, expect, it } from "vitest";
import { emitMultiStepExecuteHttp } from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Reproduces the reported "value-coincidence-threading" defect: a fold/drill
 * target's URL is rendered TWICE — once by Pass 1's `interpolateStateValues`
 * (over the raw capture, binding an EARLIER producer's response value into a
 * `${prodVar}` placeholder), then again by the fold's own per-item
 * `parameterize`/`substituteThreadedValues` pass, which re-scans that
 * ALREADY-INTERPOLATED text for its own per-item join field's value. When an
 * unrelated primary item's field happens to hold a string equal to the
 * earlier producer's OWN accessor name ("prodVar") — plausible for any
 * enum-like field — the second pass's word-boundary-anchored match still
 * fires (flanked by the placeholder's own `${`/`}`, which read as valid word
 * boundaries) and splices its own accessor INSIDE the first placeholder,
 * producing an invalid, doubly-nested `${...${...}...}` literal that cannot
 * resolve to either value at runtime.
 */
function emitDrillUrl(): string {
  const producer = {
    capture: buildCapture({
      url: "https://api.example.com/session/start",
      requestPostData: null,
      responseBody: { special: "TOKEN123" },
      timestamp: "2026-01-01T00:00:00Z",
    }),
    varName: "r0",
    produces: [{ kind: "body" as const, name: "prodVar", path: ["special"] }],
    isMultipart: false,
    isCrossDomain: false,
  };
  const search = {
    capture: buildCapture({
      url: "https://api.example.com/catalog/search/",
      requestPostData: '{"page":1}',
      responseBody: {
        results: [{ sku: "item-a", tag: "prodVar" }],
      },
      timestamp: "2026-01-01T00:00:01Z",
    }),
    varName: "r1",
    produces: [],
    isMultipart: false,
    isCrossDomain: false,
  };
  const drill = {
    capture: buildCapture({
      url: "https://api.example.com/catalog/pricing/TOKEN123/prodVar",
      requestPostData: '{"sku":"item-a"}',
      responseBody: { prices: [{ sku: "item-a", amount: 19.99 }] },
      timestamp: "2026-01-01T00:00:02Z",
    }),
    varName: "r2",
    produces: [],
    isMultipart: false,
    isCrossDomain: false,
  };

  const body = emitMultiStepExecuteHttp(
    [producer, search, drill] as unknown as Parameters<typeof emitMultiStepExecuteHttp>[0],
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
    new Map()
  );

  const match = /httpClient\(`([^`]*pricing[^`]*)`/.exec(body);
  if (!match) throw new Error("drill url not found in emitted code");
  return match[1]!;
}

describe("fold drill-down URL — cross-pass value-coincidence guard", () => {
  it("never opens a nested placeholder before a prior one closes", () => {
    const url = emitDrillUrl();

    expect(url).not.toMatch(/\$\{[^}]*\$\{/);
  });

  it("leaves the earlier producer's placeholder untouched by the later per-item pass", () => {
    const url = emitDrillUrl();

    expect(url).toContain(`$${"{prodVar}"}`);
  });

  it("still threads the per-item join field where it legitimately appears standalone", () => {
    const url = emitDrillUrl();

    expect(url).toMatch(/\$\{g0\.tag\}|\$\{item\.tag\}/);
  });
});
