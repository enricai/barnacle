import Bottleneck from "bottleneck";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createHttpClient } from "@/scraper/http-client";
import { emitMultiStepExecuteHttp } from "@/scripts/recon-generate";
import { evalExecuteHttpBody } from "@/scripts/recon-generate-execute-http-harness.test-helper";
import { buildMulticallNestedGroupedDrillDownMultiGroupActionSteps } from "@/scripts/recon-generate-multicall-fixture";

const SECTIONS_BODY = {
  sections: [
    {
      label: "featured",
      entries: [
        { entryId: "e1", name: "Widget" },
        { entryId: "e3", name: "Doohickey" },
      ],
    },
    {
      label: "clearance",
      entries: [
        { entryId: "e2", name: "Gadget" },
        { entryId: "e4", name: "Thingamajig" },
      ],
    },
  ],
};
const DETAILS_BODY = { details: [{ entryId: "e2", description: "A gadget." }] };
const NO_MATCH_DETAILS_BODY = { details: [] };

/** Stubs `fetch` to answer the fixture's calls, in call order, with each
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

describe("recon-generate drill-down fold — nested/grouped primary array runtime guard", () => {
  it("runs the emitted flatMap accessor and folds the drilled field onto the matched entry in its actual (non-first) group", async () => {
    const actionSteps = buildMulticallNestedGroupedDrillDownMultiGroupActionSteps();

    const body = emitMultiStepExecuteHttp(
      actionSteps as unknown as Parameters<typeof emitMultiStepExecuteHttp>[0],
      null,
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

    // Sanity: the nested-loop descent this test proves at runtime is actually
    // present in the emitted source (not a `.flatMap` collection, which
    // would discard the `g0` section binding), and in the right shape.
    expect(body).toContain(
      "for (const g0 of (r0 as { sections: ({ entries: Record<string, unknown>[] })[] }).sections) {"
    );
    expect(body).toContain("for (const item of g0.entries) {");
    expect(body).not.toContain(".flatMap(");

    const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    const httpClient = createHttpClient({
      schema: z.unknown(),
      bottleneck: limiter,
      baseHeaders: { "Content-Type": "application/json" },
    });

    // The emitted loop re-drills once per flattened primary item, in
    // flatMap order (sections[0].entries then sections[1].entries: e1, e3,
    // e2, e4) — only the e2 call's response carries a matching detail; the
    // other three drill calls come back empty, proving the fold leaves
    // non-matching items — in either group — untouched rather than
    // defaulting onto whatever the drill endpoint happens to return.
    stubSequentialFetch([
      SECTIONS_BODY,
      NO_MATCH_DETAILS_BODY,
      NO_MATCH_DETAILS_BODY,
      DETAILS_BODY,
      NO_MATCH_DETAILS_BODY,
    ]);

    const executeHttp = evalExecuteHttpBody(body, httpClient, z);
    const result = await executeHttp({ BaseUrl: "https://api.example.com" });

    expect(result.data).toEqual({
      sections: [
        {
          label: "featured",
          entries: [
            { entryId: "e1", name: "Widget" },
            { entryId: "e3", name: "Doohickey" },
          ],
        },
        {
          label: "clearance",
          entries: [
            { entryId: "e2", name: "Gadget", description: "A gadget." },
            { entryId: "e4", name: "Thingamajig" },
          ],
        },
      ],
    });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(5);
  });
});
