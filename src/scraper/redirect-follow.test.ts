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
      fetchFollowingRedirectsPreservingMethod("http://example.com/a", { fetchImpl: bad })
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
    expect(fetchImpl.mock.calls[1]?.[1].headers).toEqual({ "X-Test": "yes", Cookie: "sid=1" });
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
    expect(fetchImpl.mock.calls[1]?.[1].headers).toEqual({ cookie: "sid=new; keep=1" });
  });

  it.each([301, 302, 303, 307, 308])("%i without cookies leaves headers untouched", async (status) => {
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
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({ method: "POST", body: "b" });
  });
});
