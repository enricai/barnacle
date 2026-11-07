import { describe, expect, it } from "vitest";
import {
  deriveProducerBoundaryBindings,
  emitMultiStepExecuteHttp,
  extractEntryUrlParams,
  partitionBaseHeaders,
} from "@/scripts/recon-generate";

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
      step(0, "POST", `${ORIGIN}/api/cart`, {
        label: "first-label-value",
        returnUrl: `${DEEP_PAGE}?step=2`,
      }),
      step(1, "PUT", `${ORIGIN}/api/cart/items`, {
        label: "first-label-value",
        returnUrl: `${DEEP_PAGE}?step=2`,
      }),
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

describe("partitionBaseHeaders", () => {
  it("routes origin-embedding headers to the origin bucket", () => {
    const stat: Record<string, string> = {};
    const derived = new Map<string, string>();
    const tenant = new Map<string, string>();
    partitionBaseHeaders(
      { Origin: ORIGIN, Referer: DEEP_PAGE, "X-Tenant": "shop", Accept: "x" },
      ORIGIN,
      "shop",
      stat,
      derived,
      tenant
    );
    expect([...derived.keys()]).toEqual(["Origin", "Referer"]);
    expect([...tenant.keys()]).toEqual(["X-Tenant"]);
    expect(stat).toEqual({ Accept: "x" });
  });
});

describe("origin in later write and multipart steps", () => {
  const emit = (steps: unknown[], discovered: Set<string>) =>
    emitMultiStepExecuteHttp(
      steps as never,
      { returnUrl: `${DEEP_PAGE}?step=2` },
      { stringMessageKey: null, nestedErrorPaths: [] },
      new Map(),
      discovered,
      new Map(),
      new Set(),
      new Map(),
      new Map(),
      ORIGIN,
      new Map([["Origin", ORIGIN]]),
      new Map()
    );

  it("later write threading a prior response mints no origin field", () => {
    const first = step(0, "POST", `${ORIGIN}/api/cart`, { label: "first-label-value" });
    first.capture.responseBody = { cartId: "cart-identifier-12345" } as never;
    first.produces = [
      { kind: "body", name: "cartId", path: ["cartId"], leafType: "string" },
    ] as never;
    const discovered = new Set<string>();
    const body = emit(
      [
        first,
        step(1, "PUT", `${ORIGIN}/api/cart/cart-identifier-12345/items`, {
          note: "second-note-value",
          callback: `${DEEP_PAGE}?step=2`,
          cartId: "cart-identifier-12345",
        }),
      ],
      discovered
    );
    expect([...discovered].filter((f) => /callback|baseurl|origin/i.test(f))).toEqual([]);
    expect(body).not.toContain(ORIGIN);
  });

  it("later write binds its own scalar leaves, skipping empty, numeric and array leaves", () => {
    const first = step(0, "POST", `${ORIGIN}/api/cart`, { label: "first-label-value" });
    first.capture.responseBody = { cartId: "cart-identifier-12345" } as never;
    first.produces = [
      { kind: "body", name: "cartId", path: ["cartId"], leafType: "string" },
    ] as never;
    const discovered = new Set<string>();
    const body = emit(
      [
        first,
        step(1, "PUT", `${ORIGIN}/api/cart/cart-identifier-12345/items`, {
          empty: "",
          count: 3,
          note: "second-note-value",
          tags: ["array-leaf-value"],
          cartId: "cart-identifier-12345",
        }),
      ],
      discovered
    );
    expect([...discovered].some((f) => /note/i.test(f))).toBe(true);
    expect(body).not.toContain("second-note-value");
    expect(body).toContain('"empty":""');
    expect(body).toContain('"count":3');
  });

  it("multipart step carries origin header as context.baseUrl", () => {
    const mp = step(0, "POST", `${ORIGIN}/api/upload`, { a: 1 });
    mp.isMultipart = true;
    const body = emit([mp, step(1, "POST", `${ORIGIN}/api/done`, { b: 2 })], new Set());
    expect(body).not.toContain(ORIGIN);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting against emitted source
    expect(body).toContain('"Origin": `${context.baseUrl}`');
  });
});

describe.each([
  ["https://shop.example.com"],
  ["http://localhost:8080"],
  ["https://www.shop.example.co.uk:8443"],
])("origin %s as an entry body value", (origin) => {
  const emitFor = (key: string, discovered: Set<string>, additional: Map<string, unknown>) =>
    emitMultiStepExecuteHttp(
      [
        step(0, "POST", `${origin}/api/cart`, { [key]: origin, label: "first-label-value" }),
        step(1, "POST", `${origin}/api/cart/items`, { [key]: origin, other: "other-label-value" }),
      ] as never,
      { [key]: origin, label: "first-label-value" },
      { stringMessageKey: null, nestedErrorPaths: [] },
      new Map(),
      discovered,
      new Map(),
      new Set(),
      new Map(),
      additional as never,
      origin,
      new Map(),
      new Map()
    );

  it.each(["baseUrl", "base_url", "siteUrl", "origin"])(
    "never mints a payload field for the key %s",
    (key) => {
      const discovered = new Set<string>();
      const additional = new Map<string, unknown>();
      const body = emitFor(key, discovered, additional);
      expect([...discovered].filter((f) => f.toLowerCase() === key.toLowerCase())).toEqual([]);
      expect([...additional.keys()]).not.toContain(key);
      expect(body).not.toContain(origin);
      expect(body).not.toContain(`payload.${key}`);
      expect(body).toContain(`"${key}":"${"$"}{context.baseUrl}"`);
    }
  );

  it("rewrites a percent-encoded origin in a form-encoded body to the runtime origin", () => {
    const form = step(0, "POST", `${origin}/api/cart`, {});
    form.capture.requestPostData = `ref=${encodeURIComponent(origin)}&label=x`;
    const body = emitMultiStepExecuteHttp(
      [form, step(1, "POST", `${origin}/api/done`, { b: 2 })] as never,
      null,
      { stringMessageKey: null, nestedErrorPaths: [] },
      new Map(),
      new Set(),
      new Map(),
      new Set(),
      new Map(),
      new Map(),
      origin,
      new Map(),
      new Map()
    );
    expect(body).not.toContain(encodeURIComponent(origin));
    expect(body).toContain("$" + "{encodeURIComponent(context.baseUrl)}");
  });
});

describe("key-minting helpers skip origin-bearing values", () => {
  it("extractEntryUrlParams mints no key for an origin-bearing query value", () => {
    const url = `${ORIGIN}/start?returnUrl=${encodeURIComponent(`${DEEP_PAGE}?step=2`)}&jobRef=job-reference-1234`;
    const params = extractEntryUrlParams(url, ORIGIN);
    expect([...params.values()]).toEqual(["payload.jobRef"]);
  });

  it("deriveProducerBoundaryBindings mints no field for an origin-bearing produced value", () => {
    const first = step(0, "POST", `${ORIGIN}/api/cart`, { next: `${DEEP_PAGE}?step=2` });
    first.capture.responseBody = { next: `${DEEP_PAGE}?step=2`, cartId: "cart-identifier-12345" } as never;
    (first as { produces: unknown }).produces = [
      { kind: "body", name: "next", path: ["next"], leafType: "string" },
    ];
    expect(deriveProducerBoundaryBindings([first] as never, new Map(), ORIGIN).size).toBe(0);
    expect(deriveProducerBoundaryBindings([first] as never, new Map()).size).toBe(1);
  });
});
