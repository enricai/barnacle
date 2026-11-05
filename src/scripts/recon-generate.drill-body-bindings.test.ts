import { describe, expect, it } from "vitest";
import { applyDrillParamBindings, type FoldReturnSpec } from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

const URL_ = "https://api.example.com/itinerary/api/v1/sailings";
const spec: FoldReturnSpec = {
  endpointPattern: "itinerary/api/v1/sailings",
  resultsPath: "data.voyages",
  joinFields: ["id"],
  drillParamBindings: {
    adults: { payloadField: "adults", type: "int", default: 2 },
    cabin: { payloadField: "cabin", type: "string", default: "IN" },
  },
};
const capture = buildCapture({
  url: URL_,
  requestPostData: null,
  responseBody: {},
  timestamp: "2024-11-01T00:00:00Z",
});

describe("applyDrillParamBindings JSON body keys", () => {
  it("binds numeric and string JSON body keys, preserving other keys and the headers text", () => {
    const body = 'body: `{"id":"v1","adults":2,"cabin":"IN"}`,';
    expect(applyDrillParamBindings(spec, capture, body)).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting emitted source
      'body: `{"id":"v1","adults":${payload.adults ?? 2},"cabin":"${payload.cabin ?? "IN"}"}`,'
    );
    const headers = 'headers: { "content-type": `application/json` },';
    expect(applyDrillParamBindings(spec, capture, headers)).toBe(headers);
  });

  it("still rewrites query params", () => {
    expect(applyDrillParamBindings(spec, capture, `${URL_}?adults=2`)).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting emitted source
      `${URL_}?adults=\${payload.adults ?? 2}`
    );
  });
});
