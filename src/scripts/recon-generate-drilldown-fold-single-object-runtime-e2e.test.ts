import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import { emitMultiStepExecuteHttp, type FoldReturnSpec } from "@/scripts/recon-generate";
import { evalExecuteHttpBody } from "@/scripts/recon-generate-execute-http-harness.test-helper";
import { buildStep, type MulticallFixtureStep } from "@/scripts/recon-generate-multicall-fixture";

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

async function runExecuteHttp(
  actionSteps: MulticallFixtureStep[],
  foldReturnSpec: FoldReturnSpec | null
): Promise<{ data: unknown }> {
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

  const executeHttp = evalExecuteHttpBody(body, httpClient, z);
  return executeHttp({ BaseUrl: "https://api.example.com" });
}

const LINE_ITEMS_RESPONSE_BODY = {
  lineItems: [{ lineItemId: "li-1" }, { lineItemId: "li-2" }],
};
const DETAIL_RESPONSES_BY_LINE_ITEM_ID: Record<string, { lineItemId: string; quantity: number }> = {
  "li-1": { lineItemId: "li-1", quantity: 3 },
  "li-2": { lineItemId: "li-2", quantity: 7 },
};

describe("recon-generate drill-down fold executeHttp — single flat-object drill response, generic order domain", () => {
  it("folds via the structural heuristic when no foldReturn is declared", async () => {
    const fetchStub = vi.fn(async (url: string, init?: RequestInit) => {
      if (!url.includes("/orders/line-item-detail/")) {
        return jsonResponse(LINE_ITEMS_RESPONSE_BODY);
      }
      const { lineItemId } = JSON.parse(String(init?.body)) as { lineItemId: string };
      const detail = DETAIL_RESPONSES_BY_LINE_ITEM_ID[lineItemId];
      if (!detail) {
        throw new Error(`no detail fixture for lineItemId "${lineItemId}"`);
      }
      return jsonResponse(detail);
    });
    vi.stubGlobal("fetch", fetchStub);

    const actionSteps: MulticallFixtureStep[] = [
      buildStep("r0", {
        url: "https://api.example.com/orders/list/",
        requestPostData: '{"page":1}',
        responseBody: LINE_ITEMS_RESPONSE_BODY,
        timestamp: "2024-05-01T00:00:00Z",
      }),
      buildStep("r1", {
        url: "https://api.example.com/orders/line-item-detail/",
        requestPostData: '{"lineItemId":"li-1"}',
        responseBody: DETAIL_RESPONSES_BY_LINE_ITEM_ID["li-1"],
        timestamp: "2024-05-01T00:00:01Z",
      }),
    ];

    const result = await runExecuteHttp(actionSteps, null);

    expect(result.data).toEqual({
      lineItems: [
        { lineItemId: "li-1", quantity: 3 },
        { lineItemId: "li-2", quantity: 7 },
      ],
    });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
  });

  it("folds via an explicit foldReturn declaration when the join value threads only through a header", async () => {
    const fetchStub = vi.fn(async (url: string, init?: RequestInit) => {
      if (!url.includes("/orders/line-item-detail-by-header/")) {
        return jsonResponse(LINE_ITEMS_RESPONSE_BODY);
      }
      const lineItemId = (init?.headers as Record<string, string> | undefined)?.["X-Line-Item-Id"];
      const detail = lineItemId ? DETAIL_RESPONSES_BY_LINE_ITEM_ID[lineItemId] : undefined;
      if (!detail) {
        throw new Error(`no detail fixture for lineItemId "${String(lineItemId)}"`);
      }
      return jsonResponse(detail);
    });
    vi.stubGlobal("fetch", fetchStub);

    const actionSteps: MulticallFixtureStep[] = [
      buildStep("r0", {
        url: "https://api.example.com/orders/list/",
        requestPostData: '{"page":1}',
        responseBody: LINE_ITEMS_RESPONSE_BODY,
        timestamp: "2024-05-01T00:00:00Z",
      }),
      buildStep("r1", {
        url: "https://api.example.com/orders/line-item-detail-by-header/",
        requestPostData: '{"lookup":true}',
        requestHeaders: {
          "Content-Type": "application/json",
          "X-Line-Item-Id": "li-1",
        },
        responseBody: DETAIL_RESPONSES_BY_LINE_ITEM_ID["li-1"],
        timestamp: "2024-05-01T00:00:01Z",
      }),
    ];

    const foldReturnSpec: FoldReturnSpec = {
      endpointPattern: "/orders/line-item-detail-by-header/",
      resultsPath: "lineItems",
      joinFields: ["lineItemId"],
    };

    const result = await runExecuteHttp(actionSteps, foldReturnSpec);

    expect(result.data).toEqual({
      lineItems: [
        { lineItemId: "li-1", quantity: 3 },
        { lineItemId: "li-2", quantity: 7 },
      ],
    });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
  });
});
