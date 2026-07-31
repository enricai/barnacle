import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import {
  collectHeaderBindings,
  compileActionSteps,
  indexStateValues,
} from "@/scripts/recon-generate";

/**
 * Closes the seam between the emit step (`collectHeaderBindings` /
 * `bindOptionLiteral`, covered by recon-generate.test.ts and
 * recon-generate-cookie-gates.test.ts) and the runtime consumer
 * (`createHttpClient`'s `bind` option, covered by http-client.test.ts).
 * Neither existing suite proves the two actually interoperate — this file
 * runs the real generator chain and feeds its output straight into the real
 * runtime, so a field-name or casing drift between `HeaderProduce` and
 * `HttpResponseBinding` fails here even though it would pass both suites
 * independently.
 */

const passThruLimiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });

const ProductsSchema = z.object({ products: z.array(z.object({ productId: z.string() })) });
type Products = z.infer<typeof ProductsSchema>;

/** Step 0: the feature-toggle call mints three geo/analytics cookies (all
 * later threaded back on the `Cookie` request header) plus a conversation
 * id threaded back on a distinct `X-Conversation-Id` header. Reused verbatim
 * from recon-generate.test.ts:528-549 rather than re-authored. */
const toggleCapture = {
  timestamp: "2024-01-01T00:00:00Z",
  phase: "action",
  method: "GET",
  url: "https://api.example.com/toggles/product-avail",
  status: 200,
  requestHeaders: { "Content-Type": "application/json" },
  requestPostData: null,
  responseHeaders: {
    "set-cookie": [
      "latestWDPROGeoIP=US-TX-AUSTIN-1; Path=/",
      "WDPROGeoIP=US-TX-AUSTIN-2; Path=/",
      "bm_sv=BMSVSESSIONVALUE1; Path=/; HttpOnly; Secure",
      "Conversation_UUID=conv-uuid-abcdefgh; Path=/",
    ].join("\n"),
  },
  responseBody: {},
  operationName: null,
  query: null,
  variables: null,
  decodedParams: null,
};

/** Step 1: the auth call — mints `__pa` LAST among the Cookie-targeting
 * cookies, which is exactly the ordering that trips first-wins. Reused
 * verbatim from recon-generate.test.ts:553-567. */
const authzCapture = {
  timestamp: "2024-01-01T00:00:01Z",
  phase: "action",
  method: "POST",
  url: "https://api.example.com/dcl-apps-productavail-vas/authz/private",
  status: 200,
  requestHeaders: { "Content-Type": "application/json" },
  requestPostData: "{}",
  responseHeaders: { "set-cookie": "__pa=eyJhbGciOiJIUzI1NiJ9.payload.sig; Path=/; HttpOnly" },
  responseBody: {},
  operationName: null,
  query: null,
  variables: null,
  decodedParams: null,
};

/** Step 2: the stateful call that 401s without `__pa` — carries every
 * minted cookie back as a `Cookie` request header, plus the conversation
 * id back as `X-Conversation-Id`, exactly as the browser sent them. Reused
 * verbatim from recon-generate.test.ts:572-591. */
const availableProductsCapture = {
  timestamp: "2024-01-01T00:00:02Z",
  phase: "action",
  method: "GET",
  url: "https://api.example.com/dcl-apps-productavail-vas/available-products/",
  status: 200,
  requestHeaders: {
    "Content-Type": "application/json",
    Cookie:
      "latestWDPROGeoIP=US-TX-AUSTIN-1; WDPROGeoIP=US-TX-AUSTIN-2; bm_sv=BMSVSESSIONVALUE1; __pa=eyJhbGciOiJIUzI1NiJ9.payload.sig",
    "X-Conversation-Id": "conv-uuid-abcdefgh",
  },
  requestPostData: null,
  responseHeaders: { "content-type": "application/json" },
  responseBody: { products: [{ productId: "p1" }] },
  operationName: null,
  query: null,
  variables: null,
  decodedParams: null,
};

/** Mirrors http-client.test.ts's helper of the same name — the established
 * idiom for stubbing a response carrying multiple Set-Cookie entries. */
function headersWithSetCookies(...cookiePairs: string[]): Headers {
  const headers = new Headers();
  for (const pair of cookiePairs) headers.append("Set-Cookie", pair);
  return headers;
}

/** Mirrors http-client.test.ts's helper of the same name — reads the
 * outbound Cookie header fetch() was actually called with. */
function cookieHeaderFromCall(callIndex: number): string | undefined {
  const call = vi.mocked(fetch).mock.calls[callIndex];
  const headers = (call?.[1] as RequestInit)?.headers as Record<string, string>;
  return headers.Cookie;
}

describe("bind emit -> runtime round-trip (disneycruise __pa)", () => {
  const captures = [toggleCapture, authzCapture, availableProductsCapture];
  const actionCaptures = captures.map((capture, index) => ({ capture, index }));
  const stateIndex = indexStateValues(captures as never);
  const actionSteps = compileActionSteps(actionCaptures as never, stateIndex);
  const headerBindings = collectHeaderBindings(actionSteps);

  it("feeds the real collectHeaderBindings output directly into createHttpClient's bind option and threads __pa alongside the geo cookies on the second call", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          text: vi.fn().mockResolvedValue(JSON.stringify({ products: [] })),
          headers: headersWithSetCookies(
            "latestWDPROGeoIP=US-TX-AUSTIN-1; Path=/",
            "WDPROGeoIP=US-TX-AUSTIN-2; Path=/",
            "bm_sv=BMSVSESSIONVALUE1; Path=/; HttpOnly; Secure"
          ),
        })
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          text: vi.fn().mockResolvedValue(JSON.stringify({ products: [] })),
          headers: headersWithSetCookies("__pa=eyJhbGciOiJIUzI1NiJ9.payload.sig; Path=/; HttpOnly"),
        })
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          text: vi.fn().mockResolvedValue(JSON.stringify({ products: [{ productId: "p1" }] })),
          headers: new Headers(),
        })
    );

    const client = createHttpClient<Products>({
      schema: ProductsSchema,
      bottleneck: passThruLimiter,
      baseHeaders: { "Content-Type": "application/json" },
      bind: headerBindings,
    });

    await client("https://api.example.com/toggles/product-avail");
    await client("https://api.example.com/dcl-apps-productavail-vas/authz/private", {
      method: "POST",
    });
    const result = await client(
      "https://api.example.com/dcl-apps-productavail-vas/available-products/"
    );

    expect(result).toEqual({ products: [{ productId: "p1" }] });

    const cookieHeader = cookieHeaderFromCall(2);
    expect(cookieHeader).toMatch(/(^|; )__pa=eyJhbGciOiJIUzI1NiJ9\.payload\.sig(;|$)/);
    expect(cookieHeader).toContain("latestWDPROGeoIP=US-TX-AUSTIN-1");
    expect(cookieHeader).toContain("WDPROGeoIP=US-TX-AUSTIN-2");
    expect(cookieHeader).toContain("bm_sv=BMSVSESSIONVALUE1");
  });
});
