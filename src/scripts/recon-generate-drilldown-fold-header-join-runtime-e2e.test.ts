import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import { emitMultiStepExecuteHttp, type FoldReturnSpec } from "@/scripts/recon-generate";
import { evalExecuteHttpBody } from "@/scripts/recon-generate-execute-http-harness.test-helper";
import { buildMulticallSingleShotSearchDrillDownHeaderThreadedJoinMultiItemActionSteps } from "@/scripts/recon-generate-multicall-fixture";

const SEARCH_RESPONSE_BODY = {
  accounts: [
    { accountId: 42, name: "Acme" },
    { accountId: 43, name: "Globex" },
  ],
};
const TRANSACTIONS_BY_ACCOUNT_ID: Record<string, { transactions: { transactionId: string }[] }> = {
  "42": { transactions: [{ transactionId: "t-42" }] },
  "43": { transactions: [{ transactionId: "t-43" }] },
};

function jsonResponse(body: unknown): {
  status: number;
  ok: boolean;
  text: () => Promise<string>;
  headers: Headers;
} {
  return {
    status: 200,
    ok: true,
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
    headers: new Headers(),
  };
}

/** Stubs `fetch` to answer the primary search call with `SEARCH_RESPONSE_BODY`,
 * then answer every subsequent drill-down call by reading `API-Token`
 * OFF THE REQUEST HEADERS (never the URL, which is identical on every call,
 * or the body, which is empty) and returning that account's transactions —
 * proving the fold loop re-keys the header per iteration rather than
 * replaying the one header value it captured. */
function stubPerItemHeaderDrillFetch(): void {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    if (!url.includes("/accounts/detail")) {
      return jsonResponse(SEARCH_RESPONSE_BODY);
    }
    const headers = new Headers(init?.headers);
    const accountId = headers.get("API-Token");
    const response = accountId === null ? undefined : TRANSACTIONS_BY_ACCOUNT_ID[accountId];
    if (!response) {
      throw new Error(
        `stubPerItemHeaderDrillFetch: no transactions fixture for API-Token "${accountId}"`
      );
    }
    return jsonResponse(response);
  });
  vi.stubGlobal("fetch", fn);
}

describe("recon-generate header-threaded foldReturn executeHttp — generated-and-run runtime guard", () => {
  it("folds the drilled transaction onto EVERY primary account, re-keying API-Token per item", async () => {
    const actionSteps =
      buildMulticallSingleShotSearchDrillDownHeaderThreadedJoinMultiItemActionSteps();
    const inputBody = JSON.parse(actionSteps[0]!.capture.requestPostData ?? "null") as unknown;
    const foldReturnSpec: FoldReturnSpec = {
      endpointPattern: "/accounts/detail",
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

    stubPerItemHeaderDrillFetch();

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({ BaseUrl: "https://api.example.com", page: 1 });

    expect(result.data).toEqual({
      accounts: [
        { accountId: 42, name: "Acme", transactionId: "t-42" },
        { accountId: 43, name: "Globex", transactionId: "t-43" },
      ],
    });
    // One primary call plus one drill-down call per primary account.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
  });
});
