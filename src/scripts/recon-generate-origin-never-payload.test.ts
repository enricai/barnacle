import { describe, expect, it } from "vitest";
import { emitMultiStepExecuteHttp } from "@/scripts/recon-generate";

const ORIGIN = "https://shop.example.com";
const DEEP_PAGE = `${ORIGIN}/cart/items/checkout`;

const step = (n: number, method: string, url: string, body: unknown) => ({
  capture: {
    timestamp: `2024-01-01T00:00:0${n}Z`,
    phase: "action",
    method,
    url,
    status: 200,
    requestHeaders: { "Content-Type": "application/json" },
    requestPostData: JSON.stringify(body),
    responseHeaders: { "content-type": "application/json" },
    responseBody: { ok: true },
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  },
  varName: `r${n}`,
  produces: [],
  isMultipart: false,
  isCrossDomain: false,
});

describe("origin is runtime context, never a payload field or literal", () => {
  const discovered = new Set<string>();
  const entry = { returnUrl: `${DEEP_PAGE}?step=2`, label: "first-label-value" };
  const body = emitMultiStepExecuteHttp(
    [
      step(0, "POST", `${ORIGIN}/api/cart`, { label: "first-label-value", returnUrl: `${DEEP_PAGE}?step=2` }),
      step(1, "PUT", `${ORIGIN}/api/cart/items`, { label: "first-label-value", returnUrl: `${DEEP_PAGE}?step=2` }),
    ] as never,
    entry,
    { stringMessageKey: null, nestedErrorPaths: [] },
    new Map(),
    discovered,
    new Map(),
    new Set(),
    new Map(),
    new Map(),
    ORIGIN,
    new Map([
      ["Origin", ORIGIN],
      ["Referer", DEEP_PAGE],
    ]),
    new Map()
  );

  it("mints no origin-derived payload field", () => {
    expect([...discovered].filter((f) => /baseurl|returnurl|origin/i.test(f))).toEqual([]);
    expect(body).not.toMatch(/payload\.(BaseUrl|baseUrl|ReturnUrl|returnUrl)/);
  });

  it("freezes no literal origin", () => {
    expect(body).not.toContain(ORIGIN);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source
    expect(body).toContain('"Referer": `${context.baseUrl}/cart/items/checkout`');
  });
});
