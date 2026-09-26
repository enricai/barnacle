import { describe, expect, it } from "vitest";
import {
  compileActionSteps,
  deriveRequestHeaders,
  emitMultiStepExecuteHttp,
  indexStateValues,
} from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Pins the fix for a per-session correlation id being frozen into
 * BASE_HEADERS: a UUID-shaped header matched purely by NAME pattern (never
 * a site-specific string) present on every action capture with the SAME
 * value must be excluded from the derived static baseline and re-minted
 * per call via `crypto.randomUUID()`, mirroring the existing threadedTxnId
 * mechanism for body UUIDs.
 */

const LIST_URL = "https://api.example.com/catalog/search/";
const DETAIL_URL = "https://api.example.com/catalog/detail/";

const CORRELATION_ID = "3f9e2b1a-6d4c-4a7e-9c2f-1a2b3c4d5e6f";

function buildCorrelationIdCaptures(): Capture[] {
  return [
    buildCapture({
      url: LIST_URL,
      requestPostData: '{"page":1}',
      responseBody: { results: [{ itemId: "item-a" }] },
      requestHeaders: {
        "Content-Type": "application/json",
        "X-Correlation-Id": CORRELATION_ID,
      },
      timestamp: "2026-08-01T00:00:00Z",
    }),
    buildCapture({
      url: DETAIL_URL,
      requestPostData: '{"itemId":"item-a"}',
      responseBody: { ok: true },
      requestHeaders: {
        "Content-Type": "application/json",
        "X-Correlation-Id": CORRELATION_ID,
      },
      timestamp: "2026-08-01T00:00:01Z",
    }),
  ];
}

describe("recon-generate — correlation-id-shaped headers never freeze into BASE_HEADERS", () => {
  it("excludes a UUID-shaped correlation/conversation-id header from the derived baseline even when present on every capture with the same value", () => {
    const captures = buildCorrelationIdCaptures();
    const baseline = deriveRequestHeaders(captures, [], "https://api.example.com");

    for (const key of Object.keys(baseline)) {
      expect(key.toLowerCase()).not.toContain("correlation-id");
    }
    expect(Object.values(baseline)).not.toContain(CORRELATION_ID);
  });

  it("re-mints the correlation id per call from a fresh crypto.randomUUID(), not the captured literal", () => {
    const captures = buildCorrelationIdCaptures();
    const inputBody = JSON.parse(captures[0]!.requestPostData ?? "null") as unknown;
    const actionCaptures = captures.map((capture, index) => ({ capture, index }));
    const stateIndex = indexStateValues(captures, new Set(), new Set(), new Map());
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

    expect(body).not.toContain(CORRELATION_ID);
    expect(body).toMatch(/const \w+ = crypto\.randomUUID\(\);/);
    expect(body).toMatch(/"X-Correlation-Id":\s*`\$\{\w+\}`/);
  });
});
