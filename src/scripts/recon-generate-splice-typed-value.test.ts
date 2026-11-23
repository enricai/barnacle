import { describe, expect, it } from "vitest";
import { buildStepInstructionExpr } from "@/scripts/recon-generate";

const STEP = "Click its '11:30 am' time button so a 'players:' list opens under it.";

describe("payloadField splice picks the typed value span", () => {
  it("replaces '11:30 am' and leaves 'players:' without a known value", () => {
    const expr = buildStepInstructionExpr(STEP, "time");
    expect(expr).toContain("'${payload.time}'");
    expect(expr).toContain("'players:'");
  });
  it("uses identity match when the value is known", () => {
    const expr = buildStepInstructionExpr("Click 'A' then 'B'", "x", false, "A");
    expect(expr).toBe("`Click '${payload.x}' then 'B'`");
  });
  it("fill grammar still takes the last span", () => {
    expect(buildStepInstructionExpr("Fill 'Name' with 'Bob'", "n")).toBe(
      "`Fill 'Name' with '${payload.n}'`"
    );
  });
});
