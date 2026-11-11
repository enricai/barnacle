import { describe, expect, it } from "vitest";
import { deriveRequestHeaders } from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { ReplayResult } from "@/scripts/recon-shared";

const URL1 = "https://api.example.com/catalog/search/";
const URL2 = "https://api.example.com/catalog/detail/";

describe("deriveRequestHeaders consumes the replay shape verdict", () => {
  it("keeps a header omitted by a shape-diverging replay in the base headers", () => {
    const captures = [
      buildCapture({
        url: URL1,
        requestPostData: '{"page":1}',
        responseBody: { results: [] },
        requestHeaders: { "Content-Type": "application/json", "key-inflection": "camel" },
        timestamp: "2026-08-01T00:00:00Z",
      }),
      buildCapture({
        url: URL2,
        requestPostData: '{"id":"a"}',
        responseBody: { ok: true },
        requestHeaders: { "Content-Type": "application/json" },
        timestamp: "2026-08-01T00:00:01Z",
      }),
    ];
    const replays = [
      {
        url: URL1,
        method: "POST",
        operationName: null,
        replayStatus: 200,
        success: false,
        shapeDiffers: true,
        omittedCaptureHeaders: ["key-inflection"],
        shapeRestoringHeaders: ["key-inflection"],
      } as ReplayResult,
    ];
    const withVerdict = deriveRequestHeaders(captures, replays, "https://api.example.com");
    expect(withVerdict["key-inflection"]).toBe("camel");
    const without = deriveRequestHeaders(captures, [], "https://api.example.com");
    expect(without["key-inflection"]).toBeUndefined();
    const unproven = deriveRequestHeaders(
      captures,
      [{ ...replays[0]!, shapeRestoringHeaders: [] }],
      "https://api.example.com"
    );
    expect(unproven["key-inflection"]).toBeUndefined();
  });
});
