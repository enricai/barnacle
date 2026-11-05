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
