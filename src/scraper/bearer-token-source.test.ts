import Bottleneck from "bottleneck";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createBearerHeaderResolver } from "@/scraper/bearer-token-source";
import { HttpBotChallengeError, HttpSchemaError, HttpTransportError } from "@/scraper/errors";
import { createGraphqlClient } from "@/scraper/graphql-client";
import { createHttpClient } from "@/scraper/http-client";

const b = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (o: object) => `eyJhbGciOiJIUzI1NiJ9.${b(o)}.sigsigsig`;
const now = Math.floor(Date.now() / 1000);
const USER = jwt({ tokenType: "user" });
const CLIENT = jwt({ tokenType: "client", exp: now + 9999 });
const EXPIRED = jwt({ tokenType: "client", exp: now - 5 });
const page = (...t: string[]) =>
  `<script>self.__next_f.push([1,${JSON.stringify(`${t.map((x, i) => `${i + 1}a:T${x.length.toString(16)},${x}`).join("")}4e:[]`)}])</script>`;
afterEach(() => vi.unstubAllGlobals());
const setup = (html: string, o: object = {}, pageStatus = 200) => {
  let signal: unknown;
  const calls: { url: string; auth: string | null }[] = [];
  vi.stubGlobal("fetch", async (u: string | URL, i: RequestInit) => {
    calls.push({ url: String(u), auth: new Headers(i.headers).get("authorization") });
    if (String(u).includes("/plan")) signal = i.signal;
    return String(u).includes("/plan")
      ? new Response(html, { status: pageStatus })
      : new Response('{"ok":true}', { headers: { "content-type": "application/json" } });
  });
  const bottleneck = new Bottleneck({ maxConcurrent: 1 });
  const resolveHeaders = createBearerHeaderResolver({
    documentUrl: "https://a.test/plan",
    recordedBaseUrl: "https://a.test",
    claims: { tokenType: "client" },
    claimNames: [],
    bottleneck,
    headerName: "authorization",
    prefix: "Bearer ",
    bearerHosts: ["a.test"],
    otherHosts: ["cdn.test"],
    ...o,
  });
  return {
    calls,
    bottleneck,
    resolveHeaders,
    mints: () => calls.filter((c) => c.url.includes("/plan")).length,
    mintSignal: () => signal,
    http: createHttpClient({ schema: z.any(), bottleneck, baseHeaders: {}, resolveHeaders }),
  };
};
describe("scraper/bearer-token-source", () => {
  it("mints once for concurrent calls on a single-slot limiter, picking by claims", async () => {
    const s = setup(page(USER, CLIENT));
    await Promise.all([s.http("https://a.test/x"), s.http("https://a.test/y")]);
    expect(s.mints()).toBe(1);
    expect(s.calls.at(-1)?.auth).toBe(`Bearer ${CLIENT}`);
  });

  it("sends nothing to a recorded host that never carried the bearer, port included", async () => {
    const s = setup(page(CLIENT), { otherHosts: ["cdn.test:9443"] });
    await s.http("https://cdn.test:9443/x");
    expect(s.calls).toEqual([{ url: "https://cdn.test:9443/x", auth: null }]);
  });

  it("follows a tenant host, but never sends a foreign document's token to it", async () => {
    const tenant = setup(page(CLIENT));
    await tenant.http("https://tenant.test/x");
    expect(tenant.calls[0]?.url).toBe("https://tenant.test/plan");
    const foreign = setup(page(CLIENT), { documentUrl: "https://www.test/plan" });
    await foreign.http("https://a.test/x");
    expect(foreign.calls[0]?.url).toBe("https://www.test/plan");
    await foreign.http("https://tenant.test/x");
    expect(foreign.calls.at(-1)).toEqual({ url: "https://tenant.test/x", auth: null });
  });

  it("re-mints an expired token", async () => {
    const s = setup(page(EXPIRED));
    await s.http("https://a.test/x");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await s.http("https://a.test/x");
    expect(s.mints()).toBe(2);
  });

  it("fails with errors the dispatcher falls back on, and does not cache the failure", async () => {
    const missing = setup(page(USER));
    await expect(missing.http("https://a.test/x")).rejects.toBeInstanceOf(HttpSchemaError);
    await expect(missing.http("https://a.test/x")).rejects.toBeInstanceOf(HttpSchemaError);
    expect(missing.mints()).toBe(2);
    const down = setup(page(CLIENT), {}, 503);
    await expect(down.http("https://a.test/x")).rejects.toBeInstanceOf(HttpTransportError);
    const unlocated = setup(page(CLIENT), { documentUrl: null });
    await expect(unlocated.http("https://a.test/x")).rejects.toBeInstanceOf(HttpBotChallengeError);
    await expect(unlocated.http("https://cdn.test/x")).resolves.toBeDefined();
  });

  it("stops waiting when the caller aborts or the default timeout passes", async () => {
    const hung = { resolveHeaders: () => new Promise<Record<string, string>>(() => {}) };
    const client = (defaultTimeoutMs?: number) =>
      createHttpClient({
        schema: z.any(),
        bottleneck: new Bottleneck(),
        baseHeaders: {},
        defaultTimeoutMs,
        ...hung,
      });
    await expect(
      client()("https://a.test/x", { signal: AbortSignal.timeout(10) })
    ).rejects.toBeInstanceOf(HttpTransportError);
    await expect(client(10)("https://a.test/x")).rejects.toBeInstanceOf(HttpTransportError);
  });

  it("bounds the document fetch", async () => {
    const s = setup(page(CLIENT));
    await s.http("https://a.test/x");
    expect(s.mintSignal()).toBeInstanceOf(AbortSignal);
  });

  it("serves the GraphQL client", async () => {
    const s = setup(page(CLIENT));
    await createGraphqlClient({
      schema: z.any(),
      bottleneck: s.bottleneck,
      baseHeaders: {},
      endpoint: "https://a.test/graphql",
      resolveHeaders: s.resolveHeaders,
    })("q", "{a}", {});
    expect(s.calls.at(-1)?.auth).toBe(`Bearer ${CLIENT}`);
  });
});
