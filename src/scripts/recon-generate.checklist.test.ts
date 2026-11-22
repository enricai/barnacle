import { describe, expect, it } from "vitest";
import { buildContractChecklist } from "./recon-generate";

describe("buildContractChecklist baseline", () => {
  it("keeps the standard lines when no gaps are supplied", () => {
    const lines = buildContractChecklist({ pascal: "X", gql: false, gqlQuery: null });
    expect(lines.some((l) => l.startsWith("Narrow XResponseSchema"))).toBe(true);
    expect(lines.some((l) => /captcha|stops short|upload step|screening/.test(l))).toBe(false);
  });
});
