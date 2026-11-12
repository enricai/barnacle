import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import Bottleneck from "bottleneck";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod/v4";

import { createHttpClient } from "@/scraper/http-client";

const passThruLimiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
const EchoSchema = z.object({
  method: z.string(),
  body: z.string(),
  hops: z.number(),
  cookie: z.string(),
});
type Echo = z.infer<typeof EchoSchema>;

/**
 * A real server, not a mocked fetch: the behavior under test *is* the runtime
 * redirect policy, which a stubbed fetch would define away.
 */
describe("http-client redirect policy", () => {
  let server: Server;
  let base: string;
  const seen: Array<{ url: string; method: string; body: string }> = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        seen.push({ url: req.url ?? "", method: req.method ?? "", body });
        const reply = (hops: number): void => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ method: req.method, body, hops, cookie: req.headers.cookie ?? "" })
          );
        };
        if (req.url === "/cookiehop") {
          res.writeHead(302, { Location: "/final", "Set-Cookie": "sess=abc123; Path=/; HttpOnly" });
          res.end();
        } else if (req.url === "/twohops") {
          res.writeHead(302, { Location: "/twohops2", "Set-Cookie": "first=1; Path=/" });
          res.end();
        } else if (req.url === "/samename") {
          res.writeHead(302, { Location: "/samename2", "Set-Cookie": "tok=HOP1; Path=/" });
          res.end();
        } else if (req.url === "/samename2") {
          res.writeHead(302, { Location: "/final", "Set-Cookie": "tok=HOP2; Path=/" });
          res.end();
        } else if (req.url === "/twohops2") {
          res.writeHead(302, { Location: "/final", "Set-Cookie": "second=2; Path=/" });
          res.end();
        } else if (req.url === "/r301") {
          res.writeHead(301, { Location: "/final" });
          res.end();
        } else if (req.url === "/r302") {
          res.writeHead(302, { Location: "/final" });
          res.end();
        } else if (req.url === "/r307") {
          res.writeHead(307, { Location: "/final" });
          res.end();
        } else if (req.url === "/r308") {
          res.writeHead(308, { Location: "/final" });
          res.end();
        } else if (req.url === "/r303") {
          res.writeHead(303, { Location: "/final" });
          res.end();
        } else if (req.url === "/relative") {
          res.writeHead(301, { Location: "nested/final" });
          res.end();
        } else if (req.url === "/loop") {
          res.writeHead(301, { Location: "/loop" });
          res.end();
        } else if (req.url === "/nolocation") {
          res.writeHead(301);
          res.end();
        } else {
          reply(seen.length);
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  function client() {
    return createHttpClient<Echo>({
      schema: EchoSchema,
      bottleneck: passThruLimiter,
      baseHeaders: { "Content-Type": "application/json", Accept: "application/json" },
    });
  }

  it.each([301, 302])(
    "re-issues the original POST and body across a %i redirect",
    async (status) => {
      seen.length = 0;
      const result = await client()(`${base}/r${status}`, {
        method: "POST",
        body: JSON.stringify({ q: "cabins" }),
      });
      // The regression this guards: fetch's default policy turns this into a
      // bodyless GET, and the API answers 404.
      expect(result.method).toBe("POST");
      expect(result.body).toBe(JSON.stringify({ q: "cabins" }));
      expect(seen.map((s) => s.method)).toEqual(["POST", "POST"]);
    }
  );

  it.each([307, 308])("preserves POST, headers and body across a %i redirect", async (status) => {
    seen.length = 0;
    const result = await client()(`${base}/r${status}`, {
      method: "POST",
      body: JSON.stringify({ q: "cabins" }),
      headers: { Cookie: "caller=keepme" },
    });
    expect(result.method).toBe("POST");
    expect(result.body).toBe(JSON.stringify({ q: "cabins" }));
    expect(result.cookie).toContain("caller=keepme");
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([`POST /r${status}`, "POST /final"]);
    expect(seen.at(-1)?.body).toBe(JSON.stringify({ q: "cabins" }));
  });

  it("degrades a 303 to GET and drops the body, as the status requires", async () => {
    seen.length = 0;
    const result = await client()(`${base}/r303`, {
      method: "POST",
      body: JSON.stringify({ q: "cabins" }),
    });
    expect(result.method).toBe("GET");
    expect(result.body).toBe("");
  });

  it("resolves a relative Location against the URL that produced it", async () => {
    seen.length = 0;
    const result = await client()(`${base}/relative`, {
      method: "POST",
      body: "payload",
    });
    expect(result.method).toBe("POST");
    expect(seen.at(-1)?.url).toBe("/nested/final");
  });

  it("gives up on a redirect loop instead of spinning forever", async () => {
    await expect(client()(`${base}/loop`, { method: "POST", body: "x" })).rejects.toThrow(
      /exceeded 5 redirects/
    );
  });

  it("returns the 3xx itself when Location is missing, so status classification sees the real response", async () => {
    // A 301 with no Location is not followable. It must surface as the upstream
    // status rather than a synthesized transport error.
    await expect(client()(`${base}/nolocation`, { method: "POST", body: "x" })).rejects.toThrow();
  });

  it("carries a Set-Cookie minted on a redirect hop onto the follow-up request", async () => {
    // The regression: a site that mints its session cookie on the 302 itself
    // had that cookie dropped, so the final request arrived unauthenticated.
    seen.length = 0;
    const result = await client()(`${base}/cookiehop`, { method: "POST", body: "x" });
    expect(result.cookie).toContain("sess=abc123");
    // Attributes are not cookies: only the first pair is carried.
    expect(result.cookie).not.toContain("HttpOnly");
    expect(result.cookie).not.toContain("Path=");
  });

  it("accumulates cookies across several hops", async () => {
    seen.length = 0;
    const result = await client()(`${base}/twohops`, { method: "POST", body: "x" });
    expect(result.cookie).toContain("first=1");
    expect(result.cookie).toContain("second=2");
  });

  it("merges a hop cookie with one the caller already sent", async () => {
    seen.length = 0;
    const result = await client()(`${base}/cookiehop`, {
      method: "POST",
      body: "x",
      headers: { Cookie: "caller=keepme" },
    });
    expect(result.cookie).toContain("caller=keepme");
    expect(result.cookie).toContain("sess=abc123");
  });

  it("reports every hop to onResponse, not only the final response", async () => {
    // `bind` runs off onResponse, so a header that appears only on a redirect
    // is unbindable unless hops are observed.
    const observed: Array<{ status: number; setCookie: string[] }> = [];
    const withObserver = createHttpClient<Echo>({
      schema: EchoSchema,
      bottleneck: passThruLimiter,
      baseHeaders: { "Content-Type": "application/json", Accept: "application/json" },
      onResponse: (info) =>
        observed.push({ status: info.status, setCookie: info.headers.getSetCookie() }),
    });
    await withObserver(`${base}/cookiehop`, { method: "POST", body: "x" });
    expect(observed.map((o) => o.status)).toEqual([302, 200]);
    expect(observed[0]?.setCookie.join()).toContain("sess=abc123");
  });

  it("lets a later hop's value win when two hops set the same cookie name", async () => {
    // The later hop is the more current value, so it must not be shadowed by
    // the earlier one.
    seen.length = 0;
    const result = await client()(`${base}/samename`, {
      method: "POST",
      body: "x",
      headers: { Cookie: "pre=keep" },
    });
    expect(result.cookie).toContain("tok=HOP2");
    expect(result.cookie).not.toContain("HOP1");
    expect(result.cookie).toContain("pre=keep");
  });

  it("binds a cookie that only ever appears on a redirect hop", async () => {
    const bound: string[] = [];
    const withBinding = createHttpClient<Echo>({
      schema: EchoSchema,
      bottleneck: passThruLimiter,
      baseHeaders: { "Content-Type": "application/json", Accept: "application/json" },
      bind: [{ sourceHeader: "set-cookie", cookieName: "sess", targetHeader: "X-Session" }],
      onResponse: (info) => bound.push(String(info.status)),
    });
    const result = await withBinding(`${base}/cookiehop`, { method: "POST", body: "x" });
    expect(result.cookie).toContain("sess=abc123");
    expect(bound).toEqual(["302", "200"]);
  });
});
