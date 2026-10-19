import { describe, expect, it } from "vitest";
import { unreferencedDeclaredPayloadFields } from "@/scripts/recon-generate";

const STEPS = [{ step: "pick the colour", payloadField: "color" }];

describe("unreferencedDeclaredPayloadFields — per-request facet threading", () => {
  it("reports a facet whose element is threaded in one request but literal in another", () => {
    const contract = [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
      "const a = { filters: [`${payload.color};filterType=color`] };",
      'const b = { filters: ["RED;filterType=color"] };',
    ].join("\n");
    expect(unreferencedDeclaredPayloadFields(contract, "", STEPS)).toEqual(["color"]);
  });

  it("reports nothing for a fully threaded facet", () => {
    const contract = [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
      "const a = { filters: [`${payload.color};filterType=color`] };",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source, not a template
      "const b = { filters: [`${payload.color};filterType=color`] };",
    ].join("\n");
    expect(unreferencedDeclaredPayloadFields(contract, "", STEPS)).toEqual([]);
  });
});
