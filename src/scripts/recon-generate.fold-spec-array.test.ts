import { describe, expect, it } from "vitest";
import { parseFoldReturnSpec, parseFoldReturnSpecs } from "./recon-generate.js";

const flow = (foldReturn: unknown): string => JSON.stringify({ steps: [], foldReturn });
const a = { endpointPattern: "/a", resultsPath: "x.y", joinFields: ["id"] };

describe("foldReturn array parse", () => {
  it("object form unchanged", () => {
    expect(parseFoldReturnSpec(flow(a))).toEqual(a);
    expect(parseFoldReturnSpecs(flow(a))).toEqual([a]);
  });
  it("array form: ordered, inherited resultsPath, new keys", () => {
    const b = {
      endpointPattern: "/b",
      joinFields: ["k"],
      attachAs: "extra",
      payloadFlag: "wantExtra",
      drillParamBindings: { n: { payloadField: "n", type: "int", default: 1 } },
    };
    const specs = parseFoldReturnSpecs(flow([a, b]));
    expect(specs).toEqual([a, { ...b, resultsPath: "x.y" }]);
    expect(parseFoldReturnSpec(flow([a, b]))).toEqual(a);
  });
  it("rejects invalid entries", () => {
    expect(parseFoldReturnSpecs(flow([a, { endpointPattern: "/b" }]))).toBeNull();
    expect(parseFoldReturnSpecs(flow([{ ...a, resultsPath: undefined }]))).toBeNull();
    expect(parseFoldReturnSpecs(flow([a, { ...a, attachAs: "" }]))).toBeNull();
    expect(parseFoldReturnSpecs(flow([]))).toBeNull();
  });
});
