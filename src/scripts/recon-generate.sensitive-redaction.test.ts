import { describe, expect, it } from "vitest";
import { buildSensitiveRedactionPolicy } from "@/scripts/recon-generate";

describe("buildSensitiveRedactionPolicy", () => {
  it("ignores tagged steps without an explicit payloadField and untagged steps", () => {
    expect(buildSensitiveRedactionPolicy(["a", { step: "b", sensitive: "digits" }])).toBeUndefined();
  });
  it("dedupes and routes by rule", () => {
    expect(
      buildSensitiveRedactionPolicy([
        { step: "a", payloadField: "Ssn", sensitive: "digits" },
        { step: "b", payloadField: "Ssn", sensitive: "digits" },
      ])
    ).toEqual({ digitKeys: ["Ssn"] });
  });
});
