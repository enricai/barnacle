import { describe, expect, it } from "vitest";
import type { Capture } from "@/scripts/recon-shared";
import { firstEndpointCapture } from "./recon-generate.js";

const BASE = "https://api.example.com";
const cap = (method: string, path: string, body: unknown, post: string | null): Capture =>
  ({
    timestamp: "2024-01-01T00:00:00Z",
    phase: "action",
    method,
    url: `${BASE}${path}`,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: post,
    responseHeaders: { "Content-Type": "application/json" },
    responseBody: body,
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  }) as unknown as Capture;

describe("firstEndpointCapture: beacon answer-independence over body-bearing responses", () => {
  const get = cap("GET", "/search?q=a", { results: [1, 2, 3] }, null);

  it("treats a POST whose acks are one fixed body or intermittently empty as a beacon", () => {
    const sensor = [
      cap("POST", "/orders/sync", { data: ["ack"] }, '{"n":1}'),
      cap("POST", "/orders/sync", null, '{"n":2}'),
      cap("POST", "/orders/sync", "", '{"n":3}'),
      cap("POST", "/orders/sync", { data: ["ack"] }, '{"n":4}'),
    ];
    expect(firstEndpointCapture([...sensor, get])?.method).toBe("GET");
  });

  it("keeps a recurring POST whose body-bearing responses differ", () => {
    const real = [
      cap("POST", "/orders/create", { data: ["alpha-order"] }, '{"n":1}'),
      cap("POST", "/orders/create", null, '{"n":2}'),
      cap("POST", "/orders/create", { data: ["beta-order"] }, '{"n":3}'),
    ];
    expect(firstEndpointCapture(real)?.url).toBe(`${BASE}/orders/create`);
  });

  it("falls back to all responses when none carries a body", () => {
    const empties = [
      cap("POST", "/orders/ping", null, '{"n":1}'),
      cap("POST", "/orders/ping", "", '{"n":2}'),
    ];
    expect(() => firstEndpointCapture([...empties, get])).not.toThrow();
  });
});
