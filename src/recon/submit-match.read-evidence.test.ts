import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { flowHasSubmitSemantics } from "@/scraper/flow-runner";
import { readDeclaredReadMatcher } from "@/scripts/recon-shared";
import { isReadCapture } from "./submit-match";

const gql = (query: string) => JSON.stringify({ query });
const url = "https://api.shop.example.test/graphql";

describe("isReadCapture", () => {
  it("treats GET and GraphQL queries as reads, mutations and plain POSTs as not", () => {
    expect(isReadCapture({ method: "GET", url })).toBe(true);
    expect(isReadCapture({ method: "POST", url, requestPostData: gql("query Q { a }") })).toBe(
      true
    );
    expect(isReadCapture({ method: "POST", url, requestPostData: gql("mutation M { a }") })).toBe(
      false
    );
    expect(isReadCapture({ method: "POST", url, requestPostData: "a=1" })).toBe(false);
  });
});

describe("flowHasSubmitSemantics read evidence", () => {
  const base = {
    steps: [{ submitStep: false, instruction: "Type the email and click Submit" }],
    submitEndpointPattern: "/graphql",
    requireSubmitEndpointMatch: false,
  };
  it("is false with read evidence and no readOnly flag, true otherwise", () => {
    expect(flowHasSubmitSemantics({ ...base, readEvidence: true })).toBe(false);
    expect(flowHasSubmitSemantics({ ...base, readEvidence: false })).toBe(true);
    expect(flowHasSubmitSemantics(base)).toBe(true);
  });
});

describe("readDeclaredReadMatcher without readOnly", () => {
  it("matches a declared GraphQL query but not a mutation", () => {
    const f = join(mkdtempSync(join(tmpdir(), "rd-")), "flow.json");
    writeFileSync(f, JSON.stringify({ submitEndpointPattern: "/graphql" }));
    const m = readDeclaredReadMatcher(f);
    expect(m).not.toBeNull();
    expect(m?.({ method: "POST", url, requestPostData: gql("{ a }") })).toBe(true);
    expect(m?.({ method: "POST", url, requestPostData: gql("mutation M { a }") })).toBe(false);
  });
});
