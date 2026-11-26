import { describe, expect, it } from "vitest";
import {
  compileActionSteps,
  emitMultiStepExecuteHttp,
  indexStateValues,
} from "@/scripts/recon-generate";
import { buildStep } from "@/scripts/recon-generate-multicall-fixture";
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

describe("emitMultiStepExecuteHttp — CSRF prefix replay end to end", () => {
  const BASE = "https://shop.example.com";
  const T1 = "json-minted-token-aaaaaaaaaaaaaaaa";
  const T2 = "meta-issued-token-bbbbbbbbbbbbbbbb";

  function emit(): string {
    const mint = buildStep("r0", {
      url: `${BASE}/flash.json`,
      requestPostData: null,
      responseBody: { csrf: { token: T1 } },
      timestamp: "2024-01-01T00:00:01Z",
      method: "GET",
      responseHeaders: { "set-cookie": "sid=sess-value-0123456789; Path=/" },
    });
    const dup = buildStep("r1", {
      url: `${BASE}/order.json`,
      requestPostData: JSON.stringify({ game: 9 }),
      requestHeaders: {
        "Content-Type": "application/json",
        "X-CSRF-Token": T1,
        "x-csrf-token": T1,
        Referer: `${BASE}/a`,
        referer: `${BASE}/a`,
      },
      responseBody: { ok: true },
      timestamp: "2024-01-01T00:00:02Z",
      method: "POST",
    });
    const nul = buildStep("r2", {
      url: `${BASE}/order.json`,
      requestPostData: JSON.stringify({ game: 9 }),
      requestHeaders: { "Content-Type": "application/json", "X-CSRF-Token": "null" },
      responseBody: { ok: true },
      timestamp: "2024-01-01T00:00:03Z",
      method: "POST",
    });
    const page = buildStep("r3", {
      url: `${BASE}/order/edit`,
      requestPostData: null,
      responseBody: `<meta name="csrf-token" content="${T2}">`,
      timestamp: "2024-01-01T00:00:04Z",
      method: "GET",
    });
    const put = buildStep("r4", {
      url: `${BASE}/order.json`,
      requestPostData: JSON.stringify({ order: { contactName: "Recon Name" } }),
      requestHeaders: { "Content-Type": "application/json", "X-CSRF-Token": T2 },
      responseBody: { ok: true },
      timestamp: "2024-01-01T00:00:05Z",
      method: "PUT",
    });
    const tail = buildStep("r5", {
      url: `${BASE}/order/submit`,
      requestPostData: JSON.stringify({ done: true }),
      responseBody: { ok: true },
      timestamp: "2024-01-01T00:00:06Z",
      method: "POST",
    });
    const raw = [mint, dup, nul, page, put, tail];
    const actions = raw.map((s, index) => ({ capture: s.capture, index }));
    const compiled = compileActionSteps(actions, indexStateValues(raw.map((s) => s.capture)));
    // Derive produces from the real indexer->compiler path, not by hand.
    expect(compiled[0].produces).toMatchObject([{ kind: "body", path: ["csrf", "token"] }]);
    expect(compiled[3].produces).toMatchObject([
      { kind: "html", element: "meta", locatorName: "csrf-token", value: T2 },
    ]);
    raw.forEach((s, i) => {
      s.produces = compiled[i].produces as unknown as typeof s.produces;
    });
    return emitMultiStepExecuteHttp(
      raw as unknown as Parameters<typeof emitMultiStepExecuteHttp>[0],
      null,
      { stringMessageKey: null, nestedErrorPaths: [] },
      new Map(),
      new Set(),
      new Map(),
      new Set(),
      new Map(),
      new Map(),
      BASE,
      new Map(),
      new Map(),
      null,
      new Map(),
      new Map(),
      new Set(),
      [],
      new Map(),
      new Map(),
      null,
      null,
      [],
      undefined,
      undefined,
      5
    );
  }

  it("emits no credential throw, no duplicate header casings, and sends cookies", () => {
    const body = emit();
    expect(body).not.toContain("requires a runtime credential");
    expect(body).not.toContain(T1);
    expect(body).not.toContain(T2);
    expect(body).not.toContain('"x-csrf-token"');
    expect(body).not.toContain('"referer"');
    expect(body).toContain('"X-CSRF-Token"');
    expect(body).toContain("getSetCookie()");
  });
});
