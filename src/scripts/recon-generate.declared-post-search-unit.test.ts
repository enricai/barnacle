import { describe, expect, it } from "vitest";
import { classifySubmissionFlow, isDeclaredPostSearchRepeat } from "@/scripts/recon-generate";
import type { Capture } from "@/scripts/recon-shared";

function cap(o: Partial<Capture>): Capture {
  return {
    timestamp: "2024-01-01T00:00:00Z",
    phase: "action",
    method: "POST",
    url: "https://api.example.com/v1/catalog/query",
    status: 200,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: null,
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
    ...o,
  };
}
const any = () => true;
const j = (o: object) => JSON.stringify(o);

describe("isDeclaredPostSearchRepeat", () => {
  it("true for one endpoint with 2 distinct JSON bodies", () => {
    expect(
      isDeclaredPostSearchRepeat(
        [cap({ requestPostData: j({ q: "a" }) }), cap({ requestPostData: j({ q: "b" }) })],
        any
      )
    ).toBe(true);
  });
  it("false for a single hit, identical bodies, form bodies, or multiple endpoints", () => {
    const a = cap({ requestPostData: j({ q: "a" }) });
    expect(isDeclaredPostSearchRepeat([a], any)).toBe(false);
    expect(isDeclaredPostSearchRepeat([a, a], any)).toBe(false);
    expect(
      isDeclaredPostSearchRepeat(
        [cap({ requestPostData: "a=1" }), cap({ requestPostData: "a=2" })],
        any
      )
    ).toBe(false);
    expect(
      isDeclaredPostSearchRepeat(
        [a, cap({ url: "https://api.example.com/v1/other", requestPostData: j({ q: "b" }) })],
        any
      )
    ).toBe(false);
    expect(isDeclaredPostSearchRepeat([a, cap({ requestPostData: null })], any)).toBe(false);
    expect(isDeclaredPostSearchRepeat([a, cap({ requestPostData: "null" })], any)).toBe(false);
  });
  it("ignores OPTIONS and GET captures", () => {
    const a = cap({ requestPostData: j({ q: "a" }) });
    expect(
      isDeclaredPostSearchRepeat([a, cap({ method: "OPTIONS" }), cap({ method: "GET" })], any)
    ).toBe(false);
  });
});

describe("classifySubmissionFlow", () => {
  const base = {
    noReplayableActionFlow: false,
    isReadOnlyGetFlow: false,
    actionStepCount: 2,
    gql: false,
    actionCaptureMethods: ["POST", "POST"],
    graphqlActionSequenceHasMutation: false,
  };
  it("POST flow is a submission unless declared post-search read", () => {
    expect(classifySubmissionFlow(base)).toBe(true);
    expect(classifySubmissionFlow({ ...base, isDeclaredPostSearchRead: true })).toBe(false);
  });
  it("gql, OPTIONS/GET-only and no-replay branches", () => {
    expect(
      classifySubmissionFlow({ ...base, gql: true, graphqlActionSequenceHasMutation: true })
    ).toBe(true);
    expect(
      classifySubmissionFlow({ ...base, actionCaptureMethods: ["GET", "OPTIONS"] })
    ).toBe(false);
    expect(classifySubmissionFlow({ ...base, noReplayableActionFlow: true })).toBe(true);
  });
});
