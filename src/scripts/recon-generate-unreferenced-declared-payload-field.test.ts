import { describe, expect, it } from "vitest";
import { unreferencedDeclaredPayloadFields } from "@/scripts/recon-generate";

describe("unreferencedDeclaredPayloadFields", () => {
  const contract = "Facet: z.string(),\nOther: z.string(),\nconst x = payload.Other;";

  it("returns declared fields no emitted code reads", () => {
    const steps = [{ step: "pick", payloadField: "Facet" }, "plain"];
    expect(unreferencedDeclaredPayloadFields(contract, "", steps)).toEqual(["Facet"]);
  });

  it("counts a browser-flow reference and ignores prefix matches", () => {
    const steps = [{ step: "pick", payloadField: "Facet" }];
    expect(unreferencedDeclaredPayloadFields(contract, "use(payload.Facet)", steps)).toEqual([]);
    expect(unreferencedDeclaredPayloadFields(contract, "use(payload.FacetMore)", steps)).toEqual([
      "Facet",
    ]);
  });

  it("returns [] when every declared field is referenced", () => {
    const steps = [{ step: "pick", payloadField: "Other" }];
    expect(unreferencedDeclaredPayloadFields(contract, "", steps)).toEqual([]);
  });
});
