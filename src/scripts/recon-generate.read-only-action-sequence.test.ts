import { describe, expect, it } from "vitest";
import { extractActionSequence, type FoldReturnSpec } from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

const HOST = "https://api.example.com";
const fold = { endpointPattern: "/lookup/", resultsPath: "rows", joinFields: ["id"] } as unknown as FoldReturnSpec;
const submit = { endpoint: "/checkout-confirm", body: null };

const post = (path: string, body: unknown, t: number) =>
  buildCapture({
    url: `${HOST}${path}`,
    method: "POST",
    requestPostData: JSON.stringify({ n: t }),
    responseBody: body,
    timestamp: `2024-01-01T00:00:0${t}Z`,
  });
const get = (path: string, body: unknown, t: number) =>
  buildCapture({
    url: `${HOST}${path}`,
    method: "GET",
    responseBody: body,
    timestamp: `2024-01-01T00:00:0${t}Z`,
  });

describe("extractActionSequence final structural pass", () => {
  it("keeps a foldReturn drill sharing no path token with the submit endpoint, and the call that minted its id", () => {
    const caps = [
      post("/orders", { ref: "ord-12345" }, 1),
      get("/lookup/ord-12345", { rows: [] }, 2),
      post("/checkout-confirm", { ok: true }, 3),
    ];
    const out = extractActionSequence(caps, submit, fold, [], "example.com", true, null);
    const urls = out.map((a) => new URL(a.capture.url).pathname);
    expect(urls).toContain("/lookup/ord-12345");
    expect(urls).toContain("/orders");
    expect(urls).toContain("/checkout-confirm");
    expect(urls.indexOf("/orders")).toBeLessThan(urls.indexOf("/lookup/ord-12345"));
  });
});

describe("extractActionSequence repeated pages/drill calls", () => {
  it("yields the primary search before the drill when pages and drill calls repeat", () => {
    const page = (n: number, ids: string[]) =>
      get(`/search?q=a&page=${n}`, { rows: ids.map((id) => ({ id })) }, n);
    const caps = [
      page(1, ["x1", "x2"]),
      page(2, ["x3", "x4"]),
      get("/lookup/x1", { rows: [{ id: "x1" }] }, 3),
      get("/lookup/x3", { rows: [{ id: "x3" }] }, 4),
      page(1, ["x1", "x2"]),
    ];
    const out = extractActionSequence(caps, null, fold, [], "example.com", true, null);
    const urls = out.map((a) => new URL(a.capture.url).pathname);
    expect(urls, urls.join()).toContain("/search");
    expect(urls.indexOf("/search")).toBeLessThan(urls.findIndex((u) => u.startsWith("/lookup/")));
  });
});
