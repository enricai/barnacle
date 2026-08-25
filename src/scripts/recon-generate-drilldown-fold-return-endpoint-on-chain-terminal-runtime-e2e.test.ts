import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import {
  compileActionSteps,
  emitMultiStepExecuteHttp,
  type FoldReturnSpec,
  indexStateValues,
} from "@/scripts/recon-generate";
import { evalExecuteHttpBody } from "@/scripts/recon-generate-execute-http-harness.test-helper";
import { buildMulticallSingleShotSearchDrillDownHeaderThreadedJoinChainedDependentActionSteps } from "@/scripts/recon-generate-multicall-fixture";

const SEARCH_BODY = {
  accounts: [
    { accountId: 42, name: "Acme" },
    { accountId: 43, name: "Globex" },
  ],
};

const statusTokenFor = (accountId: number): string => `status-token-${accountId}`;

const TRANSACTIONS_BODY_FOR = (
  accountId: number
): { transactions: Array<Record<string, unknown>> } => ({
  transactions: [
    { statusToken: statusTokenFor(accountId), transactionId: `t-${accountId}`, amount: 19.99 },
  ],
});

/**
 * Stubs `fetch` to answer the primary search call once, the header-threaded
 * `/accounts/status` entry hop keyed by its `API-Token` header, and the
 * `/accounts/transactions` chain terminal keyed by its body's threaded
 * `statusToken` — matched by request shape rather than call order, exactly
 * like the sibling array-wrapped chained-dependent runtime guard.
 */
function stubHeaderThreadedChainedDependentFetch(): void {
  const fn = vi
    .fn()
    .mockImplementation((url: string, init?: { body?: string; headers?: unknown }) => {
      const responseBody = (() => {
        if (url.includes("/accounts/status")) {
          const headers = new Headers(init?.headers as Record<string, string> | undefined);
          const accountId = headers.get("API-Token");
          if (accountId === null) {
            throw new Error("stubHeaderThreadedChainedDependentFetch: missing API-Token header");
          }
          return { statusToken: statusTokenFor(Number(accountId)) };
        }
        if (url.includes("/accounts/transactions")) {
          const requestBody = init?.body
            ? (JSON.parse(init.body) as Record<string, unknown>)
            : null;
          const statusToken = requestBody?.statusToken;
          if (typeof statusToken !== "string") {
            throw new Error(
              `stubHeaderThreadedChainedDependentFetch: unrecognized request body ${JSON.stringify(requestBody)}`
            );
          }
          const accountId = Number(statusToken.replace("status-token-", ""));
          return TRANSACTIONS_BODY_FOR(accountId);
        }
        return SEARCH_BODY;
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

describe("recon-generate foldReturn spec targeting a chain TERMINAL endpoint — runtime guard", () => {
  it("still folds the chain's terminal transactions onto every primary account when foldReturn names the terminal endpoint, not the header-threaded entry hop", async () => {
    const steps =
      buildMulticallSingleShotSearchDrillDownHeaderThreadedJoinChainedDependentActionSteps();
    const captures = steps.map((step) => step.capture);
    const inputBody = JSON.parse(captures[0]!.requestPostData ?? "null") as unknown;

    const actionCaptures = captures.map((capture, index) => ({ capture, index }));
    const stateIndex = indexStateValues(captures);
    const actionSteps = compileActionSteps(actionCaptures as never, stateIndex);

    // A site author declares the fold against the endpoint whose OWN
    // response actually carries the transactions they want folded
    // (`/accounts/transactions`) — not the opaque `/accounts/status` entry
    // hop that merely carries the `accountId` join key onward as a
    // `statusToken`, which they have no reason to know or name.
    const foldReturnSpec: FoldReturnSpec = {
      endpointPattern: "/accounts/transactions",
      resultsPath: "accounts",
      joinFields: ["accountId"],
    };

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
      new Map(),
      null,
      new Map(),
      new Map(),
      new Set(),
      [],
      new Map(),
      new Map(),
      foldReturnSpec
    );

    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    stubHeaderThreadedChainedDependentFetch();

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({ BaseUrl: "https://api.example.com", page: 1 });

    // `statusToken` is expected on each merged item — it is the chain's own
    // terminal response field, echoed straight through by the fold merge
    // exactly like every other chained-dependent fold (see
    // recon-generate-drilldown-fold-dependent-drilldown-onto-primary-runtime-e2e.test.ts).
    const data = result.data as { accounts?: Array<Record<string, unknown>> };
    expect(data.accounts).toEqual([
      {
        accountId: 42,
        name: "Acme",
        statusToken: "status-token-42",
        transactionId: "t-42",
        amount: 19.99,
      },
      {
        accountId: 43,
        name: "Globex",
        statusToken: "status-token-43",
        transactionId: "t-43",
        amount: 19.99,
      },
    ]);

    // One primary call, plus one call per chain step (2) per primary item (2).
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1 + 2 * 2);
  });
});
