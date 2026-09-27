import { describe, expect, it } from "vitest";
import { deriveRequestHeaders } from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

/**
 * Regression coverage for a session correlation-id header being frozen
 * verbatim into the static BASE_HEADERS baseline instead of being re-minted
 * per call, matched purely by header-name shape (never a site-specific
 * string) so the fix generalizes across sites.
 */

const LIST_URL = "https://api.example.com/orders/list/";
const DETAIL_URL = "https://api.example.com/orders/detail/";

const CONVERSATION_ID = "9c1e4f2a-7b3d-4e6a-8f1c-2d3e4f5a6b7c";

function buildConversationIdCaptures(): Capture[] {
  return [
    buildCapture({
      url: LIST_URL,
      requestPostData: '{"page":1}',
      responseBody: { orders: [{ orderId: "order-a" }] },
      requestHeaders: {
        "Content-Type": "application/json",
        "X-Conversation-Id": CONVERSATION_ID,
      },
      timestamp: "2026-08-02T00:00:00Z",
    }),
    buildCapture({
      url: DETAIL_URL,
      requestPostData: '{"orderId":"order-a"}',
      responseBody: { ok: true },
      requestHeaders: {
        "Content-Type": "application/json",
        "X-Conversation-Id": CONVERSATION_ID,
      },
      timestamp: "2026-08-02T00:00:01Z",
    }),
  ];
}

describe("recon-generate — session correlation-id header is not frozen into BASE_HEADERS", () => {
  it("does not bake a UUID-shaped correlation/conversation-id header into the derived static baseline", () => {
    const captures = buildConversationIdCaptures();
    const baseline = deriveRequestHeaders(captures, [], "https://api.example.com");

    for (const key of Object.keys(baseline)) {
      expect(key.toLowerCase()).not.toContain("conversation-id");
    }
    expect(Object.values(baseline)).not.toContain(CONVERSATION_ID);
  });
});
