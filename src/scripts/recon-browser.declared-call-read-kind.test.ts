import { describe, expect, it } from "vitest";
import { flowHasSubmitSemantics } from "@/scraper/flow-runner";
import { createDeclaredCallTracker, isReadCapture } from "./recon-browser";

const steps = ["Click Continue", "Click Next"];
const gate = (read: boolean | undefined) =>
  flowHasSubmitSemantics({
    steps,
    submitEndpointPattern: "/graphql",
    declaredCallIsRead: read,
  } as Parameters<typeof flowHasSubmitSemantics>[0]);

describe("browser main-loop declared-call read kind (final click)", () => {
  it("query-document POST capture: final click skips the submit judge", () => {
    const t = createDeclaredCallTracker("/graphql", null);
    t.observe({ method: "POST", url: "https://x.test/graphql", requestPostData: JSON.stringify({ query: "query Q { a }" }) });
    expect(t.isRead()).toBe(true);
    expect(gate(t.isRead())).toBe(false);
  });
  it("GET capture is a read", () => {
    const t = createDeclaredCallTracker("/graphql", null);
    t.observe({ method: "GET", url: "https://x.test/graphql?q=1" });
    expect(t.isRead()).toBe(true);
    expect(isReadCapture("HEAD", null)).toBe(true);
  });
  it("mutation POST capture is still judged", () => {
    const t = createDeclaredCallTracker("/graphql", null);
    t.observe({ method: "POST", url: "https://x.test/graphql", requestPostData: JSON.stringify({ query: "mutation M { b }" }) });
    expect(t.isRead()).toBe(false);
    expect(gate(t.isRead())).toBe(gate(undefined));
  });
  it("no matching capture: unknown kind", () => {
    const t = createDeclaredCallTracker("/graphql", null);
    t.observe({ method: "GET", url: "https://x.test/other" });
    expect(t.isRead()).toBeUndefined();
  });
});
