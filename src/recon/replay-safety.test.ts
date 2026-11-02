import { describe, expect, it } from "vitest";

import { isSafeToReplay, unsafeReplayReason } from "./replay-safety";

describe("isSafeToReplay", () => {
  it("allows GET/HEAD/OPTIONS", () => {
    for (const method of ["GET", "head", "OPTIONS"])
      expect(isSafeToReplay({ method })).toBe(true);
  });
  it("allows GraphQL query POST", () => {
    expect(
      isSafeToReplay({
        method: "POST",
        operationName: "A",
        query: "query A { a }",
      }),
    ).toBe(true);
    expect(
      isSafeToReplay({
        method: "POST",
        operationName: "A",
        query: "{ a { b } }",
      }),
    ).toBe(true);
  });
  it("rejects plain POST/PUT/DELETE", () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"])
      expect(isSafeToReplay({ method })).toBe(false);
  });
  it("rejects GraphQL mutation/subscription, even with query-like text", () => {
    const m = { method: "POST", operationName: "M" };
    expect(isSafeToReplay({ ...m, query: "mutation M { x }" })).toBe(false);
    expect(isSafeToReplay({ ...m, query: "subscription M { x }" })).toBe(false);
    expect(
      isSafeToReplay({ ...m, query: "# query\nmutation M { query }" }),
    ).toBe(false);
  });
  it("names the reason", () => {
    expect(unsafeReplayReason({ method: "DELETE" })).toContain("DELETE");
  });
});
