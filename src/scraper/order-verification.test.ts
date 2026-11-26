import { describe, expect, it } from "vitest";

import { type VerifyRequestSpec, verifyOrderData } from "@/scraper/order-verification";
import type { FetchImpl } from "@/scraper/raw-fetch";

const spec: VerifyRequestSpec = {
  urlTemplate: "/api/orders/$" + "{orderId}",
  method: "GET",
  jsonPath: "data.status",
  expect: "paid",
};
const stub = (
  status: number,
  body: string,
  calls: Array<[string, Record<string, string>]> = []
): FetchImpl =>
  (async (url, init) => {
    calls.push([url, init.headers]);
    return { status, headers: new Headers(), text: async () => body };
  }) as FetchImpl;
const base = { origin: "https://shop.example", payload: { orderId: "a b" } };

describe("verifyOrderData", () => {
  it("verifies on 2xx and matching value, sending cookies", async () => {
    const calls: Array<[string, Record<string, string>]> = [];
    const r = await verifyOrderData(spec, {
      ...base,
      cookieHeader: "s=1",
      fetchImpl: stub(200, '{"data":{"status":"paid"}}', calls),
    });
    expect(r).toEqual({ verified: true });
    expect(calls[0]?.[0]).toBe("https://shop.example/api/orders/a%20b");
    expect(calls[0]?.[1].Cookie).toBe("s=1");
  });
  it("unverified on mismatch", async () => {
    const r = await verifyOrderData(spec, {
      ...base,
      fetchImpl: stub(200, '{"data":{"status":"new"}}'),
    });
    expect(r).toEqual({ verified: false, reason: "mismatch" });
  });
  it("unverified on non-2xx even with matching body", async () => {
    const r = await verifyOrderData(spec, {
      ...base,
      fetchImpl: stub(500, '{"data":{"status":"paid"}}'),
    });
    expect(r).toEqual({ verified: false, reason: "http-status" });
  });
  it("unverified on cross-origin url without fetching", async () => {
    const calls: Array<[string, Record<string, string>]> = [];
    const r = await verifyOrderData(
      { ...spec, urlTemplate: "https://evil.example/$" + "{orderId}" },
      { ...base, fetchImpl: stub(200, "{}", calls) }
    );
    expect(r).toEqual({ verified: false, reason: "cross-origin" });
    expect(calls).toHaveLength(0);
  });
  it("unverified on invalid JSON", async () => {
    const r = await verifyOrderData(spec, { ...base, fetchImpl: stub(200, "nope") });
    expect(r).toEqual({ verified: false, reason: "bad-json" });
  });
});
