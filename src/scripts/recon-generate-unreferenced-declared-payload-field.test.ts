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

describe("unreferencedDeclaredPayloadFields structural matching", () => {
  const contract = "Facet: z.string(),";
  const steps = [{ step: "pick", payloadField: "Facet" }];

  it("ignores payload mentions inside strings and comments", () => {
    expect(
      unreferencedDeclaredPayloadFields(contract, 'log("payload.Facet"); // payload.Facet', steps)
    ).toEqual(["Facet"]);
    expect(unreferencedDeclaredPayloadFields(contract, "/* payload.Facet */", steps)).toEqual([
      "Facet",
    ]);
  });

  it("counts a template-literal splice", () => {
    expect(
      unreferencedDeclaredPayloadFields(contract, "go(`pick ${payload.Facet}`)", steps)
    ).toEqual([]);
  });
});

describe("unreferencedDeclaredPayloadFields nested braces", () => {
  it("keeps scanning code after a block inside a template expression", () => {
    const code = "go(`a ${[1].map((x) => { return x; })} b`); read(payload.Facet);";
    expect(
      unreferencedDeclaredPayloadFields("Facet: z.string(),", code, [
        { step: "pick", payloadField: "Facet" },
      ])
    ).toEqual([]);
  });
});
