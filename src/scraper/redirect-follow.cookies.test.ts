import { describe, expect, it } from "vitest";

import { fetchFollowingRedirectsPreservingMethod } from "@/scraper/redirect-follow";

type Step = { from: string; to: string; setCookie?: string[] };

/** Runs a scripted redirect chain; returns the Cookie header seen by the last request. */
async function finalCookie(
  start: string,
  steps: Step[],
  headers?: Record<string, string>
): Promise<string> {
  const seen: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const h = new Headers(init?.headers);
    seen.push(h.get("cookie") ?? "");
    const step = steps.find((s) => s.from === url);
    if (!step) return new Response("ok", { status: 200 });
    const res = new Headers({ Location: step.to });
    for (const c of step.setCookie ?? []) res.append("Set-Cookie", c);
    return new Response(null, { status: 302, headers: res });
  }) as typeof fetch;
  await fetchFollowingRedirectsPreservingMethod(start, { headers, fetchImpl });
  return seen[seen.length - 1] ?? "";
}

const hop = (from: string, to: string, ...setCookie: string[]): Step => ({ from, to, setCookie });

describe("redirect hop cookie jar matching", () => {
  it("does not send a host-only cookie to another host", async () => {
    expect(
      await finalCookie("https://a.example.com/", [
        hop("https://a.example.com/", "https://b.example.com/x", "s=1; Path=/"),
      ])
    ).toBe("");
  });

  it("does not send a host-only cookie to a subdomain", async () => {
    expect(
      await finalCookie("https://example.com/", [
        hop("https://example.com/", "https://sub.example.com/", "s=1; Path=/"),
      ])
    ).toBe("");
  });

  it("sends a host-only cookie to the same host", async () => {
    expect(
      await finalCookie("https://example.com/", [
        hop("https://example.com/", "https://example.com/next", "s=1; Path=/"),
      ])
    ).toBe("s=1");
  });

  it("sends a Domain cookie to matching subdomains", async () => {
    expect(
      await finalCookie("https://example.com/", [
        hop("https://example.com/", "https://sub.example.com/", "s=1; Domain=example.com; Path=/"),
      ])
    ).toBe("s=1");
  });

  it("does not send a Domain cookie to a sibling domain", async () => {
    expect(
      await finalCookie("https://a.example.com/", [
        hop("https://a.example.com/", "https://other.test/", "s=1; Domain=a.example.com; Path=/"),
      ])
    ).toBe("");
    expect(
      await finalCookie("https://a.example.com/", [
        hop("https://a.example.com/", "https://notexample.com/", "s=1; Domain=example.com; Path=/"),
      ])
    ).toBe("");
  });

  it("matches Path on a segment boundary", async () => {
    const run = (to: string) =>
      finalCookie("https://example.com/", [hop("https://example.com/", to, "s=1; Path=/app")]);
    expect(await run("https://example.com/app")).toBe("s=1");
    expect(await run("https://example.com/app/x")).toBe("s=1");
    expect(await run("https://example.com/application")).toBe("");
    expect(await run("https://example.com/other")).toBe("");
  });

  it("does not send a Secure cookie over http", async () => {
    const run = (to: string) =>
      finalCookie("https://example.com/", [hop("https://example.com/", to, "s=1; Path=/; Secure")]);
    expect(await run("http://example.com/")).toBe("");
    expect(await run("https://example.com/secure")).toBe("s=1");
  });

  it("does not send expired cookies", async () => {
    for (const attr of ["Expires=Thu, 01 Jan 1970 00:00:00 GMT", "Max-Age=0", "Max-Age=-5"]) {
      expect(
        await finalCookie("https://example.com/", [
          hop("https://example.com/", "https://example.com/n", `s=1; Path=/; ${attr}`),
        ])
      ).toBe("");
    }
  });

  it("drops the caller's Cookie cross-origin but applies a matching hop cookie", async () => {
    expect(
      await finalCookie(
        "https://a.example.com/",
        [
          hop(
            "https://a.example.com/",
            "https://b.test/",
            "mine=9; Path=/",
            "wide=2; Domain=a.example.com; Path=/"
          ),
          hop("https://b.test/", "https://b.test/final", "hopb=7; Path=/"),
        ],
        { Cookie: "consent=yes" }
      )
    ).toBe("hopb=7");
  });

  it("still delivers the caller's consent cookie on a same-host redirect", async () => {
    expect(
      await finalCookie(
        "https://example.com/",
        [hop("https://example.com/", "https://example.com/next", "s=1; Path=/")],
        { Cookie: "consent=yes" }
      )
    ).toBe("consent=yes; s=1");
  });

  it("honours Max-Age and a leading-dot Domain through the hop merge", async () => {
    const run = (attr: string, to: string) =>
      finalCookie("https://example.com/", [hop("https://example.com/", to, `s=1; Path=/; ${attr}`)]);
    expect(await run("Max-Age=60", "https://example.com/n")).toBe("s=1");
    expect(await run("Domain=.example.com", "https://sub.example.com/")).toBe("s=1");
    expect(await run("Domain=.example.com", "https://notexample.com/")).toBe("");
  });

  it("sends a Secure cookie set over https to an https hop", async () => {
    expect(
      await finalCookie("https://example.com/", [
        hop("https://example.com/", "https://example.com/s", "s=1; Path=/; Secure"),
      ])
    ).toBe("s=1");
  });

  it("drops both a hop cookie and the caller cookie on a cross-origin hop", async () => {
    expect(
      await finalCookie(
        "https://a.example.com/",
        [hop("https://a.example.com/", "https://other.test/", "s=1; Path=/")],
        { Cookie: "consent=yes" }
      )
    ).toBe("");
  });

  it("carries a hop-1 cookie past a non-matching hop 2 to a matching hop 3", async () => {
    const steps = [
      hop("https://example.com/", "https://other.test/", "s=1; Domain=example.com; Path=/"),
      hop("https://other.test/", "https://sub.example.com/end"),
    ];
    const seen: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seen.push(new Headers(init?.headers).get("cookie") ?? "");
      const step = steps.find((x) => x.from === url);
      if (!step) return new Response("ok", { status: 200 });
      const h = new Headers({ Location: step.to });
      for (const c of step.setCookie ?? []) h.append("Set-Cookie", c);
      return new Response(null, { status: 302, headers: h });
    }) as typeof fetch;
    await fetchFollowingRedirectsPreservingMethod("https://example.com/", { fetchImpl });
    expect(seen).toEqual(["", "", "s=1"]);
  });
});
