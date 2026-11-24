import { describe, expect, it } from "vitest";
import { emitMultiStepExecuteHttp } from "@/scripts/recon-generate";
import { buildStep, type MulticallFixtureStep } from "@/scripts/recon-generate-multicall-fixture";

const CSRF = "csrf-token-abcdef123456";
const BASE = "https://shop.example.com";

function steps(): MulticallFixtureStep[] {
  const csrf = buildStep("r0", {
    url: `${BASE}/api/csrf`,
    requestPostData: null,
    responseBody: { csrfToken: CSRF },
    timestamp: "2024-01-01T00:00:01Z",
    method: "GET",
    responseHeaders: { "set-cookie": "sid=sess-value-0123456789; Path=/" },
  });
  csrf.produces = [{ kind: "body", name: "csrfToken", path: ["csrfToken"], leafType: "string" }];
  const cart = buildStep("r1", {
    url: `${BASE}/api/cart`,
    requestPostData: JSON.stringify({ sku: "widget-sku-0001" }),
    requestHeaders: { "x-csrf-token": CSRF, "content-type": "application/json" },
    responseBody: { cartId: "cart-id-98765432" },
    timestamp: "2024-01-01T00:00:02Z",
    method: "POST",
  });
  const put = buildStep("r2", {
    url: `${BASE}/api/cart/field`,
    requestPostData: JSON.stringify({ note: "gift-note-text-1" }),
    requestHeaders: { "x-csrf-token": CSRF, "content-type": "application/json" },
    responseBody: { ok: true },
    timestamp: "2024-01-01T00:00:03Z",
    method: "PUT",
  });
  const tail = buildStep("r3", {
    url: `${BASE}/api/cart/submit`,
    requestPostData: JSON.stringify({ done: true }),
    responseBody: { ok: true },
    timestamp: "2024-01-01T00:00:04Z",
    method: "POST",
  });
  return [csrf, cart, put, tail];
}

function emit(count?: number): string {
  return emitMultiStepExecuteHttp(
    steps() as unknown as Parameters<typeof emitMultiStepExecuteHttp>[0],
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
    count
  );
}

describe("emitMultiStepExecuteHttp — HTTP prefix variant", () => {
  it("renders only the leading steps, in order, and returns session cookies", () => {
    const body = emit(3);
    const at = (s: string) => body.indexOf(s);
    expect(at("/api/csrf")).toBeGreaterThan(-1);
    expect(at("/api/csrf")).toBeLessThan(at("/api/cart`"));
    expect(at("/api/cart`")).toBeLessThan(at("/api/cart/field"));
    expect(body).not.toContain("/api/cart/submit");
    expect(body).toContain("const httpClient = createHttpClient(");
    expect(body).toContain("return { cookies: prefixCookies };");
    expect(body).not.toContain("return { data");
    expect(body).toContain("const csrfToken = (r0 as");
    expect(body).toContain('"x-csrf-token": `${csrfToken}`');
    expect(body).not.toContain(CSRF);
  });

  it("leaves default full-flow emission unchanged", () => {
    const full = emit();
    expect(full).toBe(emit(undefined));
    expect(full).toContain("/api/cart/submit");
    expect(full).not.toContain("prefixCookies");
  });
});
