import { describe, expect, it } from "vitest";
import { extractHtmlIssuedTokens } from "@/recon/html-state-producers";

describe("extractHtmlIssuedTokens", () => {
  it("indexes form action query values with &amp; decoded", () => {
    const html = `<form action="https://example.com/apply?csrf=abc123def456ghi789&amp;hashed=H4sh%2Bvalue00000"></form>`;
    const t = extractHtmlIssuedTokens(html);
    expect(t).toContainEqual({ value: "abc123def456ghi789", element: "form-action", name: "csrf" });
    expect(t).toContainEqual({ value: "H4sh+value00000", element: "form-action", name: "hashed" });
  });
  it("indexes path segments (job id, slug) but not plain words", () => {
    const html = `<a href="/jobs/8f3a2b1c-1111-2222-3333-444455556666/senior-engineer/candidate">x</a>`;
    const t = extractHtmlIssuedTokens(html).filter((x) => x.element === "path-segment");
    expect(t.map((x) => x.value)).toEqual([
      "8f3a2b1c-1111-2222-3333-444455556666",
      "senior-engineer",
    ]);
    expect(t[0]!.name).toBe("/jobs/*/senior-engineer/candidate");
  });
  it("still indexes hidden inputs", () => {
    const t = extractHtmlIssuedTokens(`<input type="hidden" name="tok" value="v-123456789">`);
    expect(t).toEqual([{ value: "v-123456789", element: "hidden-input", name: "tok" }]);
  });
  it("returns [] for non-HTML", () => {
    expect(extractHtmlIssuedTokens({ a: 1 })).toEqual([]);
  });
});
