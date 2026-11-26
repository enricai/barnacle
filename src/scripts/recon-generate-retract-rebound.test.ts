import { describe, expect, it } from "vitest";
import {
  type NavigateToFacetBinding,
  registerStructuredPayloadField,
  retractReboundStructuredInputs,
} from "@/scripts/recon-generate";

const facet = (value: string, field: string): NavigateToFacetBinding => ({
  value,
  field,
  optional: false,
  origin: "step",
});

describe("retractReboundStructuredInputs", () => {
  const body = { items: [{ roomId: "9", count: "2" }] };
  const setup = () => {
    const keys = new Map<string, string>();
    registerStructuredPayloadField(keys, "order", body);
    return keys;
  };

  it("does nothing without facets", () => {
    const keys = setup();
    retractReboundStructuredInputs("", keys, []);
    expect(keys.has("order")).toBe(true);
  });

  it("skips fields with no recorded samples", () => {
    const keys = new Map([["ghost", "z.string()"]]);
    retractReboundStructuredInputs("", keys, [facet("9", "roomId")]);
    expect(keys.has("ghost")).toBe(true);
  });

  it("keeps a field a request still reads", () => {
    const keys = setup();
    retractReboundStructuredInputs("${payload.order}", keys, [
      facet("9", "roomId"),
      facet("2", "count"),
    ]);
    expect(keys.has("order")).toBe(true);
  });

  it("keeps a field with an uncovered leaf", () => {
    const keys = setup();
    retractReboundStructuredInputs("", keys, [facet("9", "roomId")]);
    expect(keys.has("order")).toBe(true);
  });

  it("retracts a fully rebound unread field", () => {
    const keys = setup();
    retractReboundStructuredInputs("", keys, [facet("9", "roomId"), facet("2", "count")]);
    expect(keys.has("order")).toBe(false);
  });
});
