import { describe, expect, it } from "vitest";
import { RedirectCookieJar } from "./redirect-cookie-jar.js";

const u = (s: string) => new URL(s);
function sel(setCookie: string, from: string, to: string) {
  const jar = new RedirectCookieJar();
  jar.add(setCookie, u(from));
  return jar.select(u(to));
}

describe("RedirectCookieJar", () => {
  it("host-only cookie goes only to the same host", () => {
    expect(sel("a=1", "https://x.com/", "https://x.com/p")).toEqual([["a", "1"]]);
    expect(sel("a=1", "https://x.com/", "https://y.com/")).toEqual([]);
    expect(sel("a=1", "https://x.com/", "https://sub.x.com/")).toEqual([]);
  });
  it("Domain cookie goes to subdomains, not unrelated hosts", () => {
    expect(sel("a=1; Domain=x.com", "https://x.com/", "https://sub.x.com/")).toHaveLength(1);
    expect(sel("a=1; Domain=x.com", "https://x.com/", "https://evilx.com/")).toEqual([]);
  });
  it("rejects a Domain the setter does not belong to", () => {
    expect(sel("a=1; Domain=y.com", "https://x.com/", "https://y.com/")).toEqual([]);
  });
  it("excludes path mismatch", () => {
    expect(sel("a=1; Path=/app", "https://x.com/", "https://x.com/other")).toEqual([]);
    expect(sel("a=1; Path=/app", "https://x.com/", "https://x.com/app/z")).toHaveLength(1);
    expect(sel("a=1; Path=/app", "https://x.com/", "https://x.com/apple")).toEqual([]);
  });
  it("uses the request default path", () => {
    expect(sel("a=1", "https://x.com/a/b", "https://x.com/a/c")).toHaveLength(1);
    expect(sel("a=1", "https://x.com/a/b", "https://x.com/z")).toEqual([]);
  });
  it("excludes Secure over http", () => {
    expect(sel("a=1; Secure", "https://x.com/", "http://x.com/")).toEqual([]);
    expect(sel("a=1; Secure", "https://x.com/", "https://x.com/")).toHaveLength(1);
  });
  it("excludes expired cookies", () => {
    expect(
      sel("a=1; Expires=Wed, 01 Jan 2020 00:00:00 GMT", "https://x.com/", "https://x.com/")
    ).toEqual([]);
    expect(sel("a=1; Max-Age=0", "https://x.com/", "https://x.com/")).toEqual([]);
    expect(sel("a=1; Max-Age=-5", "https://x.com/", "https://x.com/")).toEqual([]);
    expect(sel("a=1; Max-Age=60", "https://x.com/", "https://x.com/")).toHaveLength(1);
  });
});
