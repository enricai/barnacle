import { describe, expect, it } from "vitest";
import { flowHasSubmitSemantics } from "@/scraper/flow-runner";
import { createDeclaredCallTracker, isReadCapture } from "@/scripts/recon-browser";

const base = {
  steps: [
    { submitStep: false, instruction: "Fill in the name field" },
    { submitStep: false, instruction: "Click Continue" },
  ],
  submitEndpointPattern: "/graphql",
  requireSubmitEndpointMatch: false,
};

describe("flowHasSubmitSemantics declaredCallIsRead", () => {
  it("read => false", () => {
    expect(flowHasSubmitSemantics({ ...base, declaredCallIsRead: true })).toBe(false);
  });
  it("false/undefined => unchanged", () => {
    const u = flowHasSubmitSemantics({ ...base });
    expect(u).toBe(true);
    expect(flowHasSubmitSemantics({ ...base, declaredCallIsRead: false })).toBe(u);
  });
  it("explicit submitStep wins", () => {
    const steps = [{ submitStep: false }, { submitStep: true }];
    expect(flowHasSubmitSemantics({ ...base, steps, declaredCallIsRead: true })).toBe(true);
  });
});

describe("browser declared-call tracker", () => {
  it("classifies reads", () => {
    expect(isReadCapture("GET", null)).toBe(true);
    expect(isReadCapture("POST", JSON.stringify({ query: "query A { a }" }))).toBe(true);
    expect(isReadCapture("POST", JSON.stringify({ query: "mutation M { m }" }))).toBe(false);
    expect(isReadCapture("POST", "a=b")).toBe(false);
  });
  it("tracks matched capture kind", () => {
    const t = createDeclaredCallTracker("/graphql", null);
    expect(t.isRead()).toBeUndefined();
    t.observe({
      method: "POST",
      url: "https://x.io/graphql",
      requestPostData: '{"query":"{ a }"}',
    });
    expect(t.isRead()).toBe(true);
    t.observe({
      method: "POST",
      url: "https://x.io/graphql",
      requestPostData: '{"query":"mutation { m }"}',
    });
    expect(t.isRead()).toBe(false);
  });
});
