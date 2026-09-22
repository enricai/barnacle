import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import {
  compileActionSteps,
  emitMultiStepExecuteHttp,
  indexStateValues,
} from "@/scripts/recon-generate";
import { evalExecuteHttpBody } from "@/scripts/recon-generate-execute-http-harness.test-helper";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Regression for bugfix-002: a 3-hop per-item drill chain where the MIDDLE
 * hop (`r2`, a hold/confirm call) is included in `computeFoldChain`'s chain
 * only because it echoes `r1`'s `holdToken` — not because any LATER hop
 * threads anything out of `r2`'s own response — and `r2`'s own response
 * (`{ confirmed: true }`) contributes no genuine per-item data (it is
 * neither the chain terminal nor does any field of it get threaded
 * downstream). Before the fix, `emitMultiStepExecuteHttp` unconditionally
 * bound every chain hop's response to a local (`const r2 = ...`), so this
 * hop's binding is dead: nothing in the emitted fold loop ever reads `r2`,
 * which Biome's `noUnusedVariables` flags. The fix only binds a chain hop's
 * response when it is the chain terminal or has a produced value some later
 * step's request actually threads.
 */

const SEARCH_URL = "https://api.example.com/orders/search/";
const HOLD_URL = "https://api.example.com/orders/hold/";
const CONFIRM_URL = "https://api.example.com/orders/confirm/";
const AVAILABILITY_URL = "https://api.example.com/orders/availability/";

const SEARCH_BODY = {
  results: [{ orderId: "order-a" }, { orderId: "order-b" }],
};

const HOLD_BODY_FOR = (orderId: string): { holdToken: string } => ({
  // >= 8 chars: indexStateValues' MIN_STATE_VALUE_LENGTH floor requires
  // this length for the recon-capture value to register as a threaded
  // state value at all.
  holdToken: `hold-token-${orderId}`,
});

// Deliberately carries no distinguishing per-item data and mints nothing new
// — a genuine hold/confirm side-effect call whose own response is never
// read by anything downstream.
const CONFIRM_BODY = { confirmed: true };

const AVAILABILITY_BODY_FOR = (
  orderId: string
): { roomType: string; price: number; nights: number } => ({
  roomType: orderId === "order-a" ? "suite" : "standard",
  price: orderId === "order-a" ? 199.99 : 149.5,
  nights: 3,
});

function buildFixtureCaptures(): ReturnType<typeof buildCapture>[] {
  return [
    buildCapture({
      url: SEARCH_URL,
      requestPostData: '{"page":1}',
      responseBody: SEARCH_BODY,
      timestamp: "2024-12-01T00:00:00Z",
    }),
    buildCapture({
      url: HOLD_URL,
      requestPostData: '{"orderId":"order-a"}',
      responseBody: HOLD_BODY_FOR("order-a"),
      timestamp: "2024-12-01T00:00:01Z",
    }),
    buildCapture({
      url: CONFIRM_URL,
      requestPostData: `{"holdToken":"${HOLD_BODY_FOR("order-a").holdToken}"}`,
      responseBody: CONFIRM_BODY,
      timestamp: "2024-12-01T00:00:02Z",
    }),
    buildCapture({
      url: AVAILABILITY_URL,
      requestPostData: `{"holdToken":"${HOLD_BODY_FOR("order-a").holdToken}"}`,
      responseBody: AVAILABILITY_BODY_FOR("order-a"),
      timestamp: "2024-12-01T00:00:03Z",
    }),
  ];
}

function stubFetch(): void {
  const fn = vi.fn().mockImplementation((_url: string, init?: { body?: string }) => {
    const requestBody = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const responseBody = (() => {
      if (requestBody === null || typeof requestBody.page === "number") return SEARCH_BODY;
      if (typeof requestBody.orderId === "string") return HOLD_BODY_FOR(requestBody.orderId);
      if (typeof requestBody.holdToken === "string") {
        const orderId = requestBody.holdToken.replace("hold-token-", "");
        // Both the confirm and availability calls thread the same
        // `holdToken`; route by which URL is being hit via the response
        // shape callers expect isn't distinguishable from the body alone,
        // so use call ordering per order: first holdToken-keyed call for a
        // given order is the confirm hop, second is availability.
        const isFirstCallForToken = !seenHoldTokenCalls.has(requestBody.holdToken);
        seenHoldTokenCalls.add(requestBody.holdToken);
        return isFirstCallForToken ? CONFIRM_BODY : AVAILABILITY_BODY_FOR(orderId);
      }
      throw new Error(`stubFetch: unrecognized request body ${JSON.stringify(requestBody)}`);
    })();
    return Promise.resolve({
      status: 200,
      ok: true,
      text: vi.fn().mockResolvedValue(JSON.stringify(responseBody)),
      headers: new Headers(),
    });
  });
  vi.stubGlobal("fetch", fn);
}

const seenHoldTokenCalls = new Set<string>();

describe("recon-generate chain-hop unused httpClient response — regression", () => {
  it("never binds the dead middle chain hop's response to a variable, and folds the real terminal onto each item", async () => {
    const captures = buildFixtureCaptures();
    const inputBody = JSON.parse(captures[0]!.requestPostData ?? "null") as unknown;
    const actionCaptures = captures.map((capture, index) => ({ capture, index }));
    const stateIndex = indexStateValues(captures);
    const actionSteps = compileActionSteps(actionCaptures as never, stateIndex);

    const body = emitMultiStepExecuteHttp(
      actionSteps as unknown as Parameters<typeof emitMultiStepExecuteHttp>[0],
      inputBody,
      { stringMessageKey: null, nestedErrorPaths: [] },
      new Map(),
      new Set(),
      new Map(),
      new Set(),
      new Map(),
      new Map(),
      "https://api.example.com",
      new Map(),
      new Map()
    );

    // The confirm hop's call must still fire (the chain replay is faithful
    // to the recorded sequence) but must never be bound to a local — no
    // `const rN = ` immediately precedes its URL.
    expect(body).toMatch(/await httpClient\(`\$\{payload\.BaseUrl\}\/orders\/confirm\/`/);
    expect(body).not.toMatch(
      /const \w+ = \(await httpClient\(`\$\{payload\.BaseUrl\}\/orders\/confirm\/`/
    );

    // The real terminal (availability) IS bound, since its response is what
    // gets folded onto the primary item.
    expect(body).toMatch(
      /const \w+ = \(await httpClient\(`\$\{payload\.BaseUrl\}\/orders\/availability\/`/
    );

    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    stubFetch();

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({ BaseUrl: "https://api.example.com", page: 1 });

    const data = result.data as { results?: Array<Record<string, unknown>> };
    expect(data.results).toEqual([
      { orderId: "order-a", roomType: "suite", price: 199.99, nights: 3 },
      { orderId: "order-b", roomType: "standard", price: 149.5, nights: 3 },
    ]);
    // Confirm's own field is never folded onto the item.
    expect(data.results?.[0]).not.toHaveProperty("confirmed");
  });
});
