import { describe, expect, it } from "vitest";
import { isServerRenderedFormSubmit, isZeroVarianceRepeatCapture } from "./capture-filters.js";

const mk = (
  body: string,
  reqType: string,
  status: number,
  resType: string | null,
  url = "https://shop.example.com/wizard?step=next"
) => ({
  method: "POST",
  url,
  requestPostData: body,
  status,
  requestHeaders: { "Content-Type": reqType },
  responseHeaders: (resType ? { "Content-Type": resType } : {}) as Record<string, string>,
  responseBody: resType?.includes("json") ? {} : "",
});
const first = <T>(a: T[]): T => {
  const v = a[0];
  if (v === undefined) throw new Error("empty");
  return v;
};
const set = (reqType: string, status: number, resType: string | null) =>
  ["a=1", "a=2", "a=3"].map((b) => mk(b, reqType, status, resType));

describe("isServerRenderedFormSubmit", () => {
  it("accepts urlencoded/multipart answered by 302 or 200 html", () => {
    expect(
      isServerRenderedFormSubmit(mk("a", "application/x-www-form-urlencoded", 302, null))
    ).toBe(true);
    expect(
      isServerRenderedFormSubmit(
        mk("a", "multipart/form-data; boundary=x", 200, "text/html; charset=utf-8")
      )
    ).toBe(true);
  });
  it("rejects beacons and GETs", () => {
    expect(isServerRenderedFormSubmit(mk("a", "text/plain", 200, "image/gif"))).toBe(false);
    expect(
      isServerRenderedFormSubmit(mk("a", "application/x-www-form-urlencoded", 204, null))
    ).toBe(false);
    expect(
      isServerRenderedFormSubmit({
        ...mk("a", "application/x-www-form-urlencoded", 302, null),
        method: "GET",
      })
    ).toBe(false);
  });
});

describe("isZeroVarianceRepeatCapture form submits", () => {
  it.each([
    ["urlencoded 302", "application/x-www-form-urlencoded", 302, null],
    ["multipart 200 html", "multipart/form-data; boundary=x", 200, "text/html"],
  ] as const)("keeps distinct-body %s", (_n, rt, st, ct) => {
    const all = set(rt, st, ct);
    expect(isZeroVarianceRepeatCapture(first(all), all)).toBe(false);
  });
  it("keeps queryless distinct-body submits", () => {
    const all = ["a=1", "a=2", "a=3"].map((b) =>
      mk(b, "application/x-www-form-urlencoded", 302, null, "https://shop.example.com/wizard")
    );
    expect(isZeroVarianceRepeatCapture(first(all), all)).toBe(false);
  });
  it("still drops beacons", () => {
    const gif = set("text/plain", 200, "image/gif");
    expect(isZeroVarianceRepeatCapture(first(gif), gif)).toBe(true);
    const json = set("application/json", 204, "application/json");
    expect(isZeroVarianceRepeatCapture(first(json), json)).toBe(true);
  });
  it("still drops identical-body repeats", () => {
    const all = [1, 2, 3].map(() => mk("a=1", "application/x-www-form-urlencoded", 302, null));
    expect(isZeroVarianceRepeatCapture(first(all), all)).toBe(true);
  });
});
