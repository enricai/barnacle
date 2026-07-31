import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import { emitMultiStepExecuteHttp } from "@/scripts/recon-generate";
import { buildMulticallHeterogeneousActionSteps } from "@/scripts/recon-generate-multicall-fixture";

/**
 * Strips the `as <Type>` assertions `emitMultiStepExecuteHttp` writes so the
 * body can run as plain JS via `new Function`. TypeScript 7's `typescript`
 * package (this repo's devDependency) no longer exposes `transpileModule` —
 * its JS API surface is just `{ version, versionMajorMinor }` — and esbuild
 * is only a transitive dep, not resolvable from this package's own
 * node_modules. Rather than add a new dependency for one test, this strips
 * the exact, closed set of type syntax the emitter is capable of producing
 * inside an executeHttp body: `as Record<string, unknown>` (the httpClient
 * response bindings, recon-generate.ts:2383) and the nested object-literal
 * assertion types `pathToAssertionType` builds for produces[] accessors
 * (recon-generate.ts:1476-1481, e.g. `as { Auth: { Token: string } }`). Both
 * are always a parenthesized or bare `as <braces-or-Record>` suffix — never a
 * generic, interface, or decorator — so a bounded regex is exhaustive against
 * everything this emitter can write, not merely today's fixture output.
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
 * Drives the emitter's OWN executeHttp body against mocked fetch, hermetically.
 *
 * `emitMultiStepExecuteHttp` returns the executeHttp body as a string destined
 * for a generated file that imports `createHttpClient` from
 * `@enricai/barnacle/scraper/http-client` — a subpath that resolves only in a
 * built, out-of-tree consumer, never inside this repo's own test run (see
 * recon-generate.build.test.ts's docblock on the same constraint). Rather than
 * alias that specifier or spawn a real build, this test evaluates the body
 * string directly via `new Function`, injecting the exact bindings the
 * generated top-level scope provides (`httpClient`, `payload`) — the same
 * mechanism `recon-generate-multistep-return.test.ts` and
 * `recon-generate-multistep-schema-scope.test.ts` already trust to prove the
 * emitted text is correct; this test proves the emitted text also RUNS
 * correctly end to end, wired to the real `createHttpClient` engine module
 * (imported locally via `@/`, not the out-of-tree subpath) with fetch mocked.
 * No network I/O — matches this repo's offline test-suite discipline.
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
 * call's own real-shaped captured body — the exact heterogeneous-shape
 * condition G2 collapsed onto one client-wide schema. */
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

describe("recon-generate multi-call executeHttp — generated-and-run integration guard", () => {
  it("runs all three calls in order and returns the inventory body, not the last-emitted binding's body", async () => {
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

    // Mirrors what emitContractTs wires at module scope: one client-wide
    // schema (z.unknown() for multi-step flows) plus the per-call `schema:`
    // override G2 threads onto every httpClient(...) call in `body`.
    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
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
