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

describe("parseCookiePairs", () => {
  it("parses pairs and skips malformed segments", () => {
    expect(parseCookiePairs("a=1; junk; b=2=3")).toEqual([
      ["a", "1"],
      ["b", "2=3"],
    ]);
  });
});
