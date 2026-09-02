import { describe, expect, it } from "vitest";
import { applyDrillParamBindings, type FoldReturnSpec } from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

const SAILINGS_URL =
  "https://api.example.com/itinerary/api/v1/sailings?packageCode=abc&adults=2&children=0";
const UNRELATED_URL = "https://api.example.com/itinerary/api/v1/availability?adults=2&children=0";

function buildSpec(): FoldReturnSpec {
  return {
    endpointPattern: "itinerary/api/v1/sailings",
    resultsPath: "data.cruises",
    joinFields: ["id"],
    drillParamBindings: {
      adults: { payloadField: "adults", type: "int", default: 2 },
      children: { payloadField: "children", type: "int", default: 0 },
    },
  };
}

describe("applyDrillParamBindings", () => {
  it("rewrites every bound param's still-literal value to a payload accessor, leaving every other segment byte-identical", () => {
    const spec = buildSpec();
    const capture = buildCapture({
      url: SAILINGS_URL,
      requestPostData: null,
      responseBody: {},
      timestamp: "2024-11-01T00:00:00Z",
    });
    const result = applyDrillParamBindings(spec, capture, SAILINGS_URL);
    expect(result).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
      "https://api.example.com/itinerary/api/v1/sailings?packageCode=abc&adults=${payload.adults ?? 2}&children=${payload.children ?? 0}"
    );
  });

  it("passes the text through unchanged when the capture's URL doesn't match endpointPattern", () => {
    const spec = buildSpec();
    const capture = buildCapture({
      url: UNRELATED_URL,
      requestPostData: null,
      responseBody: {},
      timestamp: "2024-11-01T00:00:00Z",
    });
    expect(applyDrillParamBindings(spec, capture, UNRELATED_URL)).toBe(UNRELATED_URL);
  });

  it("passes the text through unchanged when the spec declares no drillParamBindings", () => {
    const spec: FoldReturnSpec = {
      endpointPattern: "itinerary/api/v1/sailings",
      resultsPath: "data.cruises",
      joinFields: ["id"],
    };
    const capture = buildCapture({
      url: SAILINGS_URL,
      requestPostData: null,
      responseBody: {},
      timestamp: "2024-11-01T00:00:00Z",
    });
    expect(applyDrillParamBindings(spec, capture, SAILINGS_URL)).toBe(SAILINGS_URL);
  });

  it("passes the text through unchanged when spec is null", () => {
    const capture = buildCapture({
      url: SAILINGS_URL,
      requestPostData: null,
      responseBody: {},
      timestamp: "2024-11-01T00:00:00Z",
    });
    expect(applyDrillParamBindings(null, capture, SAILINGS_URL)).toBe(SAILINGS_URL);
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder in the test description, not a template
  it("leaves a param already rewritten to a ${...} accessor by the threading pass alone", () => {
    const spec = buildSpec();
    const capture = buildCapture({
      url: SAILINGS_URL,
      requestPostData: null,
      responseBody: {},
      timestamp: "2024-11-01T00:00:00Z",
    });
    const alreadyThreaded =
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
      "https://api.example.com/itinerary/api/v1/sailings?packageCode=abc&adults=${g0.occupancy.adults}&children=0";
    expect(applyDrillParamBindings(spec, capture, alreadyThreaded)).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
      "https://api.example.com/itinerary/api/v1/sailings?packageCode=abc&adults=${g0.occupancy.adults}&children=${payload.children ?? 0}"
    );
  });

  it("treats a dotted param name as a literal, not a regex wildcard, so an unrelated param with one extra char isn't corrupted", () => {
    const spec: FoldReturnSpec = {
      endpointPattern: "itinerary/api/v1/sailings",
      resultsPath: "data.cruises",
      joinFields: ["id"],
      drillParamBindings: {
        "filter.type": { payloadField: "filterType", type: "string", default: "cabin" },
      },
    };
    const url =
      "https://api.example.com/itinerary/api/v1/sailings?filterXtype=unrelated&filter.type=cabin";
    const capture = buildCapture({
      url,
      requestPostData: null,
      responseBody: {},
      timestamp: "2024-11-01T00:00:00Z",
    });
    expect(applyDrillParamBindings(spec, capture, url)).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
      'https://api.example.com/itinerary/api/v1/sailings?filterXtype=unrelated&filter.type=${payload.filterType ?? "cabin"}'
    );
  });
});
