import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  fetchFollowingRedirectsPreservingMethod,
  parseCookiePairs,
} from "@/scraper/redirect-follow";

describe("fetchFollowingRedirectsPreservingMethod", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        const url = req.url ?? "";
        const m = /^\/r(\d{3})$/.exec(url);
        if (m) {
          res.writeHead(Number(m[1]), { Location: "/final" });
          res.end();
        } else if (url === "/abs") {
          res.writeHead(302, { Location: "/sub/page" });
          res.end();
        } else if (url === "/loop") {
          res.writeHead(302, { Location: "/loop" });
          res.end();
        } else if (url === "/noloc") {
          res.writeHead(302);
          res.end("nolocation");
        } else if (url === "/cookie1") {
          res.writeHead(302, {
            Location: "/cookie2",
            "Set-Cookie": "a=1; Path=/",
          });
          res.end();
        } else if (url === "/cookie2") {
          res.writeHead(302, {
            Location: "/final",
            "Set-Cookie": "b=2; Path=/",
          });
          res.end();
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              url,
              method: req.method,
              body,
              cookie: req.headers.cookie ?? "",
              xtest: req.headers["x-test"] ?? "",
            })
          );
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
  });

  const post = {
    method: "POST",
    body: '{"a":1}',
    headers: { "X-Test": "yes" },
  };

  it.each([301, 302, 303, 307, 308])("%i re-issues method, headers and body", async (status) => {
    const res = await fetchFollowingRedirectsPreservingMethod(`${base}/r${status}`, post);
    const j = await res.json();
    expect(j).toMatchObject({
      url: "/final",
      method: "POST",
      body: '{"a":1}',
      xtest: "yes",
    });
  });

  it.each([
    ["Headers instance", () => new Headers({ "X-Test": "yes", Cookie: "z=9" })],
    [
      "tuple array",
      () =>
        [
          ["X-Test", "yes"],
          ["Cookie", "z=9"],
        ] as [string, string][],
    ],
  ])("keeps %s headers across cookie-setting hops", async (_n, mk) => {
    const res = await fetchFollowingRedirectsPreservingMethod(`${base}/cookie1`, {
      method: "GET",
      headers: mk(),
    });
    const j = (await res.json()) as { xtest: string; cookie: string };
    expect(j.xtest).toBe("yes");
    expect(j.cookie).toBe("z=9; a=1; b=2");
  });

  it("leaves GET unaffected", async () => {
    const res = await fetchFollowingRedirectsPreservingMethod(`${base}/r301`, {
      method: "GET",
    });
    expect(await res.json()).toMatchObject({ method: "GET" });
  });

  it("resolves relative Location", async () => {
    const res = await fetchFollowingRedirectsPreservingMethod(`${base}/abs`, post);
    expect(((await res.json()) as { url: string }).url).toBe("/sub/page");
  });

  it("throws past the hop limit", async () => {
    await expect(fetchFollowingRedirectsPreservingMethod(`${base}/loop`, post)).rejects.toThrow(
      "exceeded 5 redirects"
    );
  });

  it("returns a redirect without Location as-is", async () => {
    const res = await fetchFollowingRedirectsPreservingMethod(`${base}/noloc`, post);
    expect(res.status).toBe(302);
    expect(await res.text()).toBe("nolocation");
  });

  it("returns non-redirect responses directly", async () => {
    const res = await fetchFollowingRedirectsPreservingMethod(`${base}/plain`, post);
    expect(res.status).toBe(200);
  });

  it("merges hop cookies with the caller's Cookie", async () => {
    const res = await fetchFollowingRedirectsPreservingMethod(`${base}/cookie1`, {
      method: "GET",
      headers: { Cookie: "mine=0" },
    });
    expect(((await res.json()) as { cookie: string }).cookie).toBe("mine=0; a=1; b=2");
  });

  it("does not send a host-only hop cookie to another host", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: [
            ["Location", "http://other.example.net/x"],
            ["Set-Cookie", "sid=1; Path=/"],
          ],
        })
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    await fetchFollowingRedirectsPreservingMethod("http://example.com/a", {
      method: "GET",
      headers: { Cookie: "mine=0" },
      fetchImpl,
    });
    const headers = fetchImpl.mock.calls[1]?.[1].headers as Record<string, string>;
    expect(headers.Cookie ?? headers.cookie).toBeUndefined();
  });

  it("calls onHop for every response", async () => {
    const onHop = vi.fn();
    await fetchFollowingRedirectsPreservingMethod(`${base}/cookie1`, { method: "GET" }, onHop);
    expect(onHop.mock.calls.map((c) => c[0].status)).toEqual([302, 302, 200]);
    expect(onHop.mock.calls[0]?.[0].url).toBe(`${base}/cookie1`);
  });

  it("uses the injected fetch with redirect:manual and the abort signal", async () => {
    const ac = new AbortController();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { Location: "/x" } }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const res = await fetchFollowingRedirectsPreservingMethod("http://example.com/a", {
      method: "POST",
      body: "b",
      signal: ac.signal,
      fetchImpl,
    });
    expect(await res.text()).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("http://example.com/x");
    for (const call of fetchImpl.mock.calls) {
      expect(call[1]).toMatchObject({
        redirect: "manual",
        signal: ac.signal,
        method: "POST",
        body: "b",
      });
    }
  });
});

describe("fetchFollowingRedirectsPreservingMethod caller inputs", () => {
  it("forces redirect:manual even when the caller asks for follow", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("ok", { status: 200 }));
    await fetchFollowingRedirectsPreservingMethod("http://example.com/a", {
      method: "POST",
      redirect: "follow",
      fetchImpl,
    });
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it("follows exactly five hops but throws on the sixth", async () => {
    const hop = () => new Response(null, { status: 302, headers: { Location: "/n" } });
    const ok = vi
      .fn()
      .mockResolvedValueOnce(hop())
      .mockResolvedValueOnce(hop())
      .mockResolvedValueOnce(hop())
      .mockResolvedValueOnce(hop())
      .mockResolvedValueOnce(hop())
      .mockResolvedValueOnce(new Response("done", { status: 200 }));
    const res = await fetchFollowingRedirectsPreservingMethod("http://example.com/a", {
      method: "POST",
      body: "b",
      fetchImpl: ok,
    });
    expect(await res.text()).toBe("done");
    const bad = vi.fn().mockImplementation(async () => hop());
    await expect(
      fetchFollowingRedirectsPreservingMethod("http://example.com/a", {
        fetchImpl: bad,
      })
    ).rejects.toThrow("exceeded 5 redirects");
    expect(bad).toHaveBeenCalledTimes(6);
  });
});

describe("parseCookiePairs", () => {
  it("parses pairs and skips malformed segments", () => {
    expect(parseCookiePairs("a=1; junk; b=2=3")).toEqual([
      ["a", "1"],
      ["b", "2=3"],
    ]);
  });
});

describe("fetchFollowingRedirectsPreservingMethod header characterization", () => {
  const redirect = (status: number, extra: Record<string, string> = {}) =>
    new Response(null, { status, headers: { Location: "/next", ...extra } });

  it("keeps plain-object headers across a cookie-setting hop", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirect(302, { "Set-Cookie": "sid=1; Path=/" }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    await fetchFollowingRedirectsPreservingMethod("http://example.com/a", {
      method: "POST",
      body: "b",
      headers: { "X-Test": "yes" },
      fetchImpl,
    });
    expect(Object.fromEntries(new Headers(fetchImpl.mock.calls[1]?.[1].headers))).toEqual({
      "x-test": "yes",
      cookie: "sid=1",
    });
  });

  const shapes: Array<[string, () => ConstructorParameters<typeof Headers>[0]]> = [
    ["Headers instance", () => new Headers({ "X-Test": "yes", Cookie: "z=9" })],
    [
      "tuple array",
      () => [
        ["X-Test", "yes"],
        ["Cookie", "z=9"],
      ],
    ],
    ["plain object", () => ({ "X-Test": "yes", Cookie: "z=9" })],
  ];

  describe.each([301, 302, 303])("%i", (status) => {
    it.each(shapes)("keeps method, body, header and merged Cookie for %s", async (_n, mk) => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(redirect(status, { "Set-Cookie": "sid=1; Path=/" }))
        .mockResolvedValueOnce(new Response("ok", { status: 200 }));
      await fetchFollowingRedirectsPreservingMethod("http://example.com/a", {
        method: "POST",
        body: "b",
        headers: mk(),
        fetchImpl,
      });
      const init = fetchImpl.mock.calls[1]?.[1];
      expect(init).toMatchObject({ method: "POST", body: "b" });
      const h = new Headers(init.headers);
      expect(h.get("x-test")).toBe("yes");
      expect(h.get("cookie")).toBe("z=9; sid=1");
    });
  });

  it("lets a hop cookie win over the caller's cookie of the same name", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirect(301, { "Set-Cookie": "sid=new; Path=/" }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    await fetchFollowingRedirectsPreservingMethod("http://example.com/a", {
      headers: { cookie: "sid=old; keep=1" },
      fetchImpl,
    });
    expect(Object.fromEntries(new Headers(fetchImpl.mock.calls[1]?.[1].headers))).toEqual({
      cookie: "sid=new; keep=1",
    });
  });

  it.each([301, 302, 303, 307, 308])(
    "%i without cookies leaves headers untouched",
    async (status) => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(redirect(status))
        .mockResolvedValueOnce(new Response("ok", { status: 200 }));
      const headers = { "X-Test": "yes" };
      await fetchFollowingRedirectsPreservingMethod("http://example.com/a", {
        method: "POST",
        body: "b",
        headers,
        fetchImpl,
      });
      expect(fetchImpl.mock.calls[1]?.[1].headers).toBe(headers);
      expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({
        method: "POST",
        body: "b",
      });
    }
  );
});

describe("fetchFollowingRedirectsPreservingMethod baseline (characterization)", () => {
  const redirect = (status: number, location: string, extra: Record<string, string> = {}) =>
    new Response(null, { status, headers: { Location: location, ...extra } });

  it("keeps Authorization, Cookie and x-api-key on a same-origin redirect", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirect(302, "https://example.com/b"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    await fetchFollowingRedirectsPreservingMethod("https://example.com/a", {
      method: "GET",
      headers: { Authorization: "Bearer t", Cookie: "s=1", "x-api-key": "k" },
      fetchImpl,
    });
    expect(fetchImpl.mock.calls[1]?.[1].headers).toEqual({
      Authorization: "Bearer t",
      Cookie: "s=1",
      "x-api-key": "k",
    });
  });

  it.each([301, 302, 303, 307, 308])("%i keeps method and body (mocked)", async (status) => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirect(status, "/next"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    await fetchFollowingRedirectsPreservingMethod("https://example.com/a", {
      method: "PUT",
      body: "payload",
      fetchImpl,
    });
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("https://example.com/next");
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({ method: "PUT", body: "payload" });
  });

  it("carries a same-host Set-Cookie to the next hop", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirect(302, "/home", { "Set-Cookie": "sid=abc; Path=/; HttpOnly" }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    await fetchFollowingRedirectsPreservingMethod("https://example.com/login", {
      method: "GET",
      headers: { "x-api-key": "k" },
      fetchImpl,
    });
    expect(fetchImpl.mock.calls[1]?.[1].headers).toEqual({
      "x-api-key": "k",
      Cookie: "sid=abc",
    });
  });

  it("resolves relative Location forms against the producing URL", async () => {
    const cases: Array<[string, string]> = [
      ["/abs", "https://example.com/abs"],
      ["sibling", "https://example.com/dir/sibling"],
      ["../up", "https://example.com/up"],
      ["//other.example.com/p", "https://other.example.com/p"],
    ];
    for (const [loc, expected] of cases) {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(redirect(301, loc))
        .mockResolvedValueOnce(new Response("ok", { status: 200 }));
      await fetchFollowingRedirectsPreservingMethod("https://example.com/dir/page", {
        fetchImpl,
      });
      expect(fetchImpl.mock.calls[1]?.[0]).toBe(expected);
    }
  });
});

describe("fetchFollowingRedirectsPreservingMethod same-origin characterization", () => {
  const redirect = (status: number, location: string, extra: Record<string, string> = {}) =>
    new Response(null, { status, headers: { Location: location, ...extra } });
  const ok = () => new Response("ok", { status: 200 });

  it("keeps every header on every same-origin hop", async () => {
    const headers = {
      Authorization: "Bearer t",
      "Proxy-Authorization": "Basic p",
      Cookie: "s=1",
      "x-api-key": "k",
      "x-custom": "c",
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirect(302, "/b"))
      .mockResolvedValueOnce(redirect(307, "https://example.com/c"))
      .mockResolvedValueOnce(ok());
    await fetchFollowingRedirectsPreservingMethod("https://example.com/a", {
      method: "GET",
      headers,
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    for (const call of fetchImpl.mock.calls) {
      expect(call[1].headers).toEqual(headers);
    }
  });

  it.each([301, 302, 303, 307, 308])(
    "%i keeps method, body and all headers on a header-bearing POST",
    async (status) => {
      const headers = { Authorization: "Bearer t", "x-api-key": "k", "x-custom": "c" };
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(redirect(status, "/next"))
        .mockResolvedValueOnce(ok());
      await fetchFollowingRedirectsPreservingMethod("https://example.com/a", {
        method: "POST",
        body: '{"a":1}',
        headers,
        fetchImpl,
      });
      expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({
        method: "POST",
        body: '{"a":1}',
        headers,
      });
    }
  );

  it("attaches a consent cookie on the next hop and keeps it on a second same-host hop", async () => {
    // The follower mutates one init object across hops, so snapshot headers at call time.
    const seen: unknown[] = [];
    const responses = [
      redirect(302, "/consent", { "Set-Cookie": "consent=yes; Path=/" }),
      redirect(302, "/final"),
      ok(),
    ];
    const fetchImpl = vi.fn(async (_u: unknown, init?: RequestInit) => {
      seen.push(init?.headers === undefined ? undefined : { ...(init.headers as object) });
      return responses.shift() as Response;
    });
    await fetchFollowingRedirectsPreservingMethod("https://example.com/a", {
      method: "GET",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(seen).toEqual([undefined, { Cookie: "consent=yes" }, { Cookie: "consent=yes" }]);
  });

  it("merges a hop cookie with the caller's Cookie and other headers", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirect(302, "/b", { "Set-Cookie": "sid=abc; Path=/" }))
      .mockResolvedValueOnce(ok());
    await fetchFollowingRedirectsPreservingMethod("https://example.com/a", {
      method: "GET",
      headers: { Cookie: "mine=0", Authorization: "Bearer t" },
      fetchImpl,
    });
    expect(fetchImpl.mock.calls[1]?.[1].headers).toEqual({
      Cookie: "mine=0; sid=abc",
      Authorization: "Bearer t",
    });
  });
});

describe("fetchFollowingRedirectsPreservingMethod cross-origin credentials", () => {
  const redirect = (location: string) =>
    new Response(null, { status: 307, headers: { Location: location } });
  const creds = {
    Authorization: "Bearer t",
    "Proxy-Authorization": "p",
    Cookie: "s=1",
    "X-API-Key": "k",
    "x-custom": "c",
  };
  it.each(["https://other.com/b", "http://example.com/b", "https://example.com:8443/b"])(
    "drops credentials but keeps method, body, other headers for %s",
    async (loc) => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(redirect(loc))
        .mockResolvedValueOnce(new Response("ok"));
      await fetchFollowingRedirectsPreservingMethod("https://example.com/a", {
        method: "POST",
        body: "x",
        headers: creds,
        fetchImpl,
      });
      const init = fetchImpl.mock.calls[1]?.[1];
      expect(init.headers).toEqual({ "x-custom": "c" });
      expect(init).toMatchObject({ method: "POST", body: "x" });
    }
  );
  it("accepts Headers and tuple input", async () => {
    for (const headers of [new Headers(creds), Object.entries(creds)]) {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(redirect("https://other.com/b"))
        .mockResolvedValueOnce(new Response("ok"));
      await fetchFollowingRedirectsPreservingMethod("https://example.com/a", {
        headers,
        fetchImpl,
      });
      expect(fetchImpl.mock.calls[1]?.[1].headers).toEqual({ "x-custom": "c" });
    }
  });
  it("stays dropped on later hops even when back on the original origin", async () => {
    const seen: unknown[] = [];
    const fetchImpl = vi.fn(async (u: string, init?: RequestInit) => {
      seen.push({ ...(init?.headers as object) });
      if (u.endsWith("/a")) return redirect("https://other.com/b");
      if (u.endsWith("/b")) return redirect("https://other.com/c");
      if (u.endsWith("/c")) return redirect("https://example.com/d");
      return new Response("ok");
    });
    await fetchFollowingRedirectsPreservingMethod("https://example.com/a", {
      headers: { Authorization: "t" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(seen).toEqual([{ Authorization: "t" }, {}, {}, {}]);
  });
});

describe("fetchFollowingRedirectsPreservingMethod cross-origin across statuses", () => {
  const creds = {
    Authorization: "Bearer t",
    "Proxy-Authorization": "p",
    Cookie: "s=1",
    "X-API-Key": "k",
    "x-custom": "c",
  };
  it.each([301, 302, 303, 307, 308])(
    "%i to another host strips credentials, keeps method/body/other headers",
    async (status) => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(null, { status, headers: { Location: "https://other.com/b" } })
        )
        .mockResolvedValueOnce(new Response("ok"));
      await fetchFollowingRedirectsPreservingMethod("https://example.com/a", {
        method: "POST",
        body: "x",
        headers: creds,
        fetchImpl,
      });
      expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://example.com/a");
      expect(fetchImpl.mock.calls[1]?.[0]).toBe("https://other.com/b");
      const init = fetchImpl.mock.calls[1]?.[1];
      expect(init.headers).toEqual({ "x-custom": "c" });
      expect(init).toMatchObject({ method: "POST", body: "x" });
    }
  );
  it("A->B->A keeps credentials stripped and keeps body", async () => {
    const seen: Array<{ url: string; headers: unknown; method?: string; body?: unknown }> = [];
    const fetchImpl = vi.fn(async (u: string, init?: RequestInit) => {
      seen.push({
        url: u,
        headers: { ...(init?.headers as object) },
        method: init?.method,
        body: init?.body,
      });
      if (u === "https://a.com/1")
        return new Response(null, { status: 302, headers: { Location: "https://b.com/2" } });
      if (u === "https://b.com/2")
        return new Response(null, { status: 302, headers: { Location: "https://a.com/3" } });
      return new Response("ok");
    });
    await fetchFollowingRedirectsPreservingMethod("https://a.com/1", {
      method: "POST",
      body: "x",
      headers: creds,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(seen.map((s) => s.headers)).toEqual([creds, { "x-custom": "c" }, { "x-custom": "c" }]);
    expect(seen.every((s) => s.method === "POST" && s.body === "x")).toBe(true);
  });
});
