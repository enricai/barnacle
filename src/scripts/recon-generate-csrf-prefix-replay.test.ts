import { describe, expect, it } from "vitest";
import { indexStateValues } from "@/scripts/recon-generate";
import type { Capture } from "@/scripts/recon-shared";

const TOKEN = "a".repeat(40) + "B".repeat(46);

const base = {
  timestamp: "2024-01-01T00:00:00Z",
  phase: "action",
  status: 200,
  requestPostData: null,
  operationName: null,
  query: null,
  variables: null,
  decodedParams: null,
} as const;

const get = {
  ...base,
  method: "GET",
  url: "https://shop.example.com/session",
  requestHeaders: {},
  responseHeaders: { "content-type": "application/json" },
  responseBody: { csrf: { token: TOKEN, param: "authenticity_token" } },
} as unknown as Capture;

const post = {
  ...base,
  method: "POST",
  url: "https://shop.example.com/order",
  requestHeaders: { "x-csrf-token": TOKEN },
  requestPostData: "{}",
  responseHeaders: {},
  responseBody: { ok: true },
} as unknown as Capture;

describe("indexStateValues GET-JSON minted token", () => {
  it("indexes a GET body token later re-sent as a request header", () => {
    const idx = indexStateValues([get, post]);
    expect(idx.get(TOKEN)).toMatchObject({ originIndex: 0, path: ["csrf", "token"] });
  });
  it("does not index when no later request header carries it", () => {
    const idx = indexStateValues([get, { ...post, requestHeaders: {} } as Capture]);
    expect(idx.has(TOKEN)).toBe(false);
  });
});
