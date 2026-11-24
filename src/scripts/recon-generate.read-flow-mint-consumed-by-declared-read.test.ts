import { describe, expect, it } from "vitest";
import {
  compileActionSteps,
  extractActionSequence,
  indexStateValues,
  stepFeedsDeclaredSubmit,
} from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

const HOST = "https://api.shop-example.test";
const TOKEN = "tok_Zk9qXv81T3mWb7LpR2dYc5Hn";
const HTML = `<html><form action="/go?csrf=${TOKEN}"></form></html>`;
const htmlMint = () =>
  cap("/page", 1, { resp: HTML, respHeaders: { "content-type": "text/html" } });
const submit = { endpoint: "/rows", body: null };

const cap = (
  path: string,
  t: number,
  o: {
    method?: string;
    body?: string | null;
    headers?: Record<string, string>;
    respHeaders?: Record<string, string>;
    resp?: unknown;
  } = {}
) =>
  buildCapture({
    url: path.startsWith("http") ? path : `${HOST}${path}`,
    method: o.method ?? "GET",
    requestPostData: o.body ?? null,
    requestHeaders: o.headers,
    responseHeaders: o.respHeaders,
    responseBody: o.resp ?? { ok: true },
    timestamp: `2024-01-01T00:00:0${t}Z`,
  });

function run(caps: ReturnType<typeof cap>[]) {
  const seq = extractActionSequence(caps, submit, null, [], "shop-example.test", false, null);
  const idx = new Set(seq.map((a) => a.index));
  const steps = compileActionSteps(seq, indexStateValues(caps, new Set(), idx));
  const isDeclared = (c: unknown) => c === caps.find((x) => x.url.includes("/rows"));
  return { seq, steps, isDeclared };
}
const kept = (r: ReturnType<typeof run>, c: unknown) => r.seq.some((a) => a.capture === c);

describe("read flow: GET mint consumed by the declared GET read", () => {
  it("keeps a mint whose token is re-sent in the declared read's query", () => {
    const mint = htmlMint();
    const read = cap(`/rows?csrf=${TOKEN}`, 2);
    const r = run([mint, read]);
    expect(kept(r, mint)).toBe(true);
    expect(stepFeedsDeclaredSubmit(mint, r.steps, r.isDeclared)).toBe(true);
  });

  it("keeps a mint whose token is re-sent in the declared read's header", () => {
    const mint = cap("/csrf", 1, { resp: { token: TOKEN }, respHeaders: { "x-csrf-token": TOKEN } });
    const read = cap("/rows", 2, { headers: { "x-csrf-token": TOKEN } });
    const r = run([mint, read]);
    expect(kept(r, mint)).toBe(true);
    expect(stepFeedsDeclaredSubmit(mint, r.steps, r.isDeclared)).toBe(true);
  });

  it("still treats mint + analytics POSTs feeding nothing declared as chrome", () => {
    const mint = htmlMint();
    const beacon = cap("https://metrics.tracker-example.test/collect", 2, {
      method: "POST",
      body: JSON.stringify({ e: 1 }),
    });
    const read = cap("/rows", 3);
    const r = run([mint, beacon, read]);
    expect(kept(r, mint)).toBe(false);
    expect(kept(r, beacon)).toBe(false);
  });

  it("keeps a mint consumed only by a beacon incidental", () => {
    const mint = htmlMint();
    const beacon = cap("/analytics", 2, { method: "POST", body: JSON.stringify({ t: TOKEN }) });
    const read = cap("/rows", 3);
    const r = run([mint, beacon, read]);
    expect(stepFeedsDeclaredSubmit(mint, r.steps, r.isDeclared)).toBe(false);
  });
});
