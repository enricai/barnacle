import { describe, expect, it } from "vitest";
import { compileOptionalRegex, recordMatchedCapture } from "@/scripts/recon-browser";

const fresh = () => ({ sawMatchedRead: false, sawMatchedWrite: false });

describe("compileOptionalRegex", () => {
  it("returns null for empty/undefined and invalid patterns", () => {
    expect(compileOptionalRegex(undefined)).toBeNull();
    expect(compileOptionalRegex("")).toBeNull();
    expect(compileOptionalRegex("(")).toBeNull();
  });
  it("compiles valid patterns", () => {
    expect(compileOptionalRegex("/api/")?.test("https://x.com/api/y")).toBe(true);
  });
});

describe("recordMatchedCapture", () => {
  const rx = /\/apply/;
  it("ignores everything when no endpoint pattern", () => {
    const e = fresh();
    recordMatchedCapture({ method: "GET", url: "https://x.com/apply" }, null, null, e);
    expect(e).toEqual(fresh());
  });
  it("ignores non-matching captures", () => {
    const e = fresh();
    recordMatchedCapture({ method: "POST", url: "https://x.com/other" }, rx, null, e);
    expect(e).toEqual(fresh());
  });
  it("marks a matching GET as read", () => {
    const e = fresh();
    recordMatchedCapture({ method: "GET", url: "https://x.com/apply" }, rx, null, e);
    expect(e).toEqual({ sawMatchedRead: true, sawMatchedWrite: false });
  });
  it("marks a matching POST as write", () => {
    const e = fresh();
    recordMatchedCapture(
      { method: "POST", url: "https://x.com/apply", requestPostData: "a=1" },
      rx,
      null,
      e
    );
    expect(e).toEqual({ sawMatchedRead: false, sawMatchedWrite: true });
  });
});
