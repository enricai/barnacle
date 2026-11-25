import { describe, expect, it } from "vitest";

import { createSubmitPatternObserver } from "@/scripts/recon-browser";

describe("recon-browser/createSubmitPatternObserver", () => {
  it("records method and query only for URLs matching the pattern", () => {
    const sink: Array<{ method: string; query?: string | null }> = [];
    const observe = createSubmitPatternObserver("/api/apply$", sink);
    observe({ url: "https://x.example/api/apply", method: "POST", query: "mutation A { a }" });
    observe({ url: "https://x.example/api/other", method: "GET" });
    expect(sink).toEqual([{ method: "POST", query: "mutation A { a }" }]);
  });

  it("observes nothing without a pattern", () => {
    const sink: Array<{ method: string; query?: string | null }> = [];
    createSubmitPatternObserver(null, sink)({ url: "https://x.example/a", method: "POST" });
    expect(sink).toEqual([]);
  });
});
