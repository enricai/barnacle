import { describe, expect, it } from "vitest";
import { isZeroVarianceRepeatCapture } from "@/recon/capture-filters";
import { buildCapture } from "@/scripts/recon-generate-multicall-fixture";
import type { Capture } from "@/scripts/recon-shared";

describe("isZeroVarianceRepeatCapture — decision-site scan stays near-linear at large-pool scale", () => {
  it("resolves ~5000 candidates across many distinct method+endpoint groups, mirroring recon-generate.ts's per-candidate .filter() call shape, well under an O(n^2) bound", () => {
    const GROUP_COUNT = 500;
    const PER_GROUP = 10;

    const pool: Capture[] = Array.from({ length: GROUP_COUNT }, (_, g) =>
      Array.from({ length: PER_GROUP }, (_, p) =>
        buildCapture({
          method: "GET",
          url: `https://api.example.com/catalog/listing-${g}?clientId=client-${g}&page=${p + 1}`,
          requestPostData: null,
          responseBody: null,
          timestamp: `2024-01-01T00:00:${String(g % 60).padStart(2, "0")}Z`,
        })
      )
    ).flat();

    expect(pool).toHaveLength(GROUP_COUNT * PER_GROUP);

    const start = performance.now();
    const verdicts = pool.map((candidate) => isZeroVarianceRepeatCapture(candidate, pool));
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(3000);
    // Every candidate shares a group-fixed `clientId` query key and an
    // identical (null) request body with every other occurrence at its own
    // method+endpoint, which is sufficient for the function's own fixed-key
    // + body-identical rule to classify all of them as zero-variance repeats.
    expect(verdicts.every((verdict) => verdict === true)).toBe(true);
  });
});
