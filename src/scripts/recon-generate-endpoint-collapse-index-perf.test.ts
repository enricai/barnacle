import { describe, expect, it } from "vitest";
import type { ActionCapture } from "@/scripts/recon-generate";
import { isRedundantSameEndpointGroup } from "@/scripts/recon-generate";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

function toGroup(captures: Capture[]): ActionCapture[] {
  return captures.map((capture, index) => ({ capture, index }));
}

function fatResponseBody(seed: string): unknown {
  return {
    items: Array.from({ length: 8 }, (_, i) => ({
      id: `${seed}-${i}`,
      meta: { createdBy: `user-${seed}-${i}`, tags: [`tag-${i}-a`, `tag-${i}-b`] },
    })),
  };
}

describe("recon-generate — endpoint-collapse index perf at near-real-archive scale", () => {
  it("resolves many same-endpoint pagination groups (with a second non-pagination varying key) against a ~4800-capture pool well under 5s, all still collapsing", () => {
    const GROUP_COUNT = 600;
    const PAGES_PER_GROUP = 5;
    const UNRELATED_COUNT = 4800 - GROUP_COUNT * PAGES_PER_GROUP;

    const groups: ActionCapture[][] = Array.from({ length: GROUP_COUNT }, (_, g) =>
      toGroup(
        Array.from({ length: PAGES_PER_GROUP }, (_, p) =>
          buildCapture({
            url: `https://api.example.com/catalog/listing-${g}?page=${p + 1}&sid=session-${g}-${p}`,
            requestPostData: null,
            responseBody: fatResponseBody(`${g}-${p}`),
            timestamp: `2024-01-01T00:00:${String(g % 60).padStart(2, "0")}Z`,
          })
        )
      )
    );
    const unrelatedCorpus: Capture[] = Array.from({ length: UNRELATED_COUNT }, (_, i) =>
      buildCapture({
        url: `https://api.example.com/unrelated/${i}`,
        requestPostData: null,
        responseBody: fatResponseBody(`unrelated-${i}`),
        timestamp: `2024-01-02T00:${String(i % 60).padStart(2, "0")}:00Z`,
      })
    );

    const allActions = toGroup([
      ...groups.flatMap((group) => group.map((a) => a.capture)),
      ...unrelatedCorpus,
    ]);

    const start = performance.now();
    const verdicts = groups.map((group) => isRedundantSameEndpointGroup(group, allActions));
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(5000);
    expect(verdicts.every((verdict) => verdict === true)).toBe(true);
  });
});
