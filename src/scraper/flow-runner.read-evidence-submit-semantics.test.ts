import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isReadCapture } from "@/recon/submit-match";
import { flowHasSubmitSemantics } from "@/scraper/flow-runner";
import { readDeclaredReadMatcher } from "@/scripts/recon-shared";

const url = "https://api.voyages.example.test/graphql";
const gql = (query: string) => JSON.stringify({ query });
const LAST = "Click the first sailing-date link on the first voyage card";
const readFlow = {
  steps: [
    { submitStep: false, instruction: "Select the destination Fjords" },
    { submitStep: false, instruction: LAST },
  ],
  submitEndpointPattern: "/graphql",
  requireSubmitEndpointMatch: false,
};

describe("flowHasSubmitSemantics with read evidence", () => {
  it("a read flow ending in the sailing-date link is not submit-shaped given query/GET evidence", () => {
    for (const cap of [
      { method: "GET", url },
      { method: "POST", url, requestPostData: gql("query Sailings { s }") },
    ]) {
      expect(flowHasSubmitSemantics({ ...readFlow, readEvidence: isReadCapture(cap) })).toBe(false);
    }
  });
  it("mutation evidence keeps the pattern-implied submit", () => {
    const cap = { method: "POST", url, requestPostData: gql("mutation Book { b }") };
    expect(flowHasSubmitSemantics({ ...readFlow, readEvidence: isReadCapture(cap) })).toBe(true);
  });
  it("an explicit submitStep flag stays authoritative over read evidence", () => {
    const steps = [{ submitStep: true, instruction: LAST }];
    expect(flowHasSubmitSemantics({ ...readFlow, steps, readEvidence: true })).toBe(true);
  });
});

describe("readDeclaredReadMatcher without readOnly", () => {
  const f = join(mkdtempSync(join(tmpdir(), "rd-")), "flow.json");
  writeFileSync(f, JSON.stringify({ submitEndpointPattern: "/graphql" }));
  const m = readDeclaredReadMatcher(f);
  it("matches declared query/GET captures but not mutations", () => {
    expect(m).not.toBeNull();
    expect(m?.({ method: "GET", url })).toBe(true);
    expect(m?.({ method: "POST", url, requestPostData: gql("{ s }") })).toBe(true);
    expect(m?.({ method: "POST", url, requestPostData: gql("mutation M { b }") })).toBe(false);
  });
  it("the matcher result drives the verbatim final step to a non-submit flow", () => {
    const cap = { method: "POST", url, requestPostData: gql("query Sailings { s }") };
    expect(flowHasSubmitSemantics({ ...readFlow, readEvidence: m?.(cap) === true })).toBe(false);
  });
});
