import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import { emitMultiStepExecuteHttp } from "@/scripts/recon-generate";
import { buildMulticallHeterogeneousActionSteps } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Strips the `as <Type>` assertions `emitMultiStepExecuteHttp` writes so the
 * body can run as plain JS via `new Function` — same closed-set regex as
 * `recon-generate-multistep-e2e.test.ts`'s `stripEmitterTypeAssertions`,
 * duplicated here rather than imported since neither test file exports it.
 */
function stripEmitterTypeAssertions(body: string): string {
  const stripped = body.replace(/ as (?:Record<string, unknown>|\{[^;]+?\})/g, "");
  if (/\bas\s+[A-Za-z{]/.test(stripped)) {
    throw new Error(
      `stripEmitterTypeAssertions left unstripped TS syntax — emitter output grew a new ` +
        `assertion shape this harness doesn't cover:\n${stripped}`
    );
  }
  return stripped;
}

/**
 * Drives the emitter's OWN executeHttp body against mocked fetch, hermetically
 * — see `recon-generate-multistep-e2e.test.ts`'s `evalExecuteHttpBody` for why
 * `new Function` rather than a real module import of the generated file.
 */
function evalExecuteHttpBody(
  body: string,
  httpClient: ReturnType<typeof createHttpClient>
): (payload: Record<string, unknown>) => Promise<{ data: unknown }> {
  const stripped = stripEmitterTypeAssertions(body);
  const factory = new Function(
    "httpClient",
    "z",
    `return async function executeHttp(payload) {\n${stripped}\n};`
  ) as (
    httpClient: unknown,
    z: unknown
  ) => (payload: Record<string, unknown>) => Promise<{ data: unknown }>;
  return factory(httpClient, z);
}

const TOGGLES_BODY = [{ name: "feature-a", enabled: true }];
const AUTHZ_BODY = { result: "anonymous", successful: true };
const PRODUCTS_PAGE_1_BODY = {
  totalPages: 5,
  totalAvailableCruises: 699,
  products: [{ productId: "p1" }],
};
const PRODUCTS_PAGE_2_BODY = {
  totalPages: 5,
  totalAvailableCruises: 699,
  products: [{ productId: "p2" }],
};

/** Stubs `fetch` to answer the fixture's four calls, in call order, with each
 * call's own real-shaped captured body. */
function stubSequentialFetch(bodies: unknown[]): void {
  const fn = vi.fn();
  for (const body of bodies) {
    fn.mockResolvedValueOnce({
      status: 200,
      ok: true,
      text: vi.fn().mockResolvedValue(JSON.stringify(body)),
      headers: new Headers(),
    });
  }
  vi.stubGlobal("fetch", fn);
}

describe("recon-generate multi-call executeHttp — narrowed client schema runtime guard", () => {
  it("completes and returns the inventory body when the client is built with the checklist's narrowed ResponseSchema, not z.unknown()", async () => {
    const actionSteps = buildMulticallHeterogeneousActionSteps();
    const inputBody = JSON.parse(actionSteps[0]!.capture.requestPostData ?? "null") as unknown;

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

    // Reproduces the bug report's own repro step: an author follows the
    // emitted `[ ] Narrow ResponseSchema` checklist item and substitutes the
    // real `available-products/` shape for the client's default z.unknown().
    // Every individual httpClient(...) call still carries its own per-call
    // `schema:` override (recon-generate.ts:2381), so this narrowed
    // client-wide default must never be reached by the toggles/authz calls.
    const narrowedResponseSchema = z.object({
      totalPages: z.number(),
      totalAvailableCruises: z.number(),
      products: z.array(z.unknown()),
    });
    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: narrowedResponseSchema,
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    stubSequentialFetch([TOGGLES_BODY, AUTHZ_BODY, PRODUCTS_PAGE_1_BODY, PRODUCTS_PAGE_2_BODY]);

    const executeHttp = evalExecuteHttpBody(body, httpClient);
    const result = await executeHttp({ BaseUrl: "https://api.example.com", page: 2 });

    const data = result.data as { totalAvailableCruises?: unknown; products?: unknown[] };
    expect(typeof data.totalAvailableCruises).toBe("number");
    expect(Array.isArray(data.products) && data.products.length > 0).toBe(true);
    expect(data).toEqual(PRODUCTS_PAGE_2_BODY);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(4);
  });
});
