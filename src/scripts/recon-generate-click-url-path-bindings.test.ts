import { describe, expect, it } from "vitest";
import { addClickUrlPathBindings } from "@/scripts/recon-generate";

describe("addClickUrlPathBindings", () => {
  it("binds state-like entry path segments to payload.ClickUrl positions, keeping existing entries", () => {
    const into = new Map<string, string>([["abc", "payload.x"]]);
    const out = addClickUrlPathBindings(
      "https://h.example.com/jobs/48213907/senior-widget-engineer/apply",
      into
    );
    expect(out).toBe(into);
    expect(out.get("abc")).toBe("payload.x");
    expect(out.get("48213907")).toBe('new URL(payload.ClickUrl).pathname.split("/")[2]');
    expect(out.get("senior-widget-engineer")).toBe(
      'new URL(payload.ClickUrl).pathname.split("/")[3]'
    );
    expect(out.has("jobs")).toBe(false);
  });

  it("does not overwrite an existing binding for the same segment", () => {
    const into = new Map([["48213907", "payload.id"]]);
    addClickUrlPathBindings("https://h.example.com/jobs/48213907", into);
    expect(into.get("48213907")).toBe("payload.id");
  });

  it("returns the map unchanged for an unparseable URL", () => {
    const into = new Map<string, string>();
    expect(addClickUrlPathBindings("", into).size).toBe(0);
  });
});
