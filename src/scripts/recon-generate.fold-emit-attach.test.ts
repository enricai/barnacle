import { describe, expect, it } from "vitest";
import {
  emitFoldMatchAndMergeLines,
  type FoldTarget,
  foldOneDrillOccurrence,
  inferChainStepResponseSchema,
  inferZodSchemaFromSamples,
  wholeArrayAttachKey,
  wrapIsolatedDrillLines,
} from "@/scripts/recon-generate";

const URL_ = "https://api.example.com/v1/reviews?itemId=1";
const rows = [{ stars: 5 }, { stars: 4 }];

function target(over: Partial<FoldTarget> = {}): FoldTarget {
  return {
    joinFields: ["id"],
    drillStepIndex: 1,
    drillArrayPath: [],
    primaryMatchedItemIndex: 0,
    chain: [1],
    chainArrayPath: ["rows"],
    chainTerminalIndex: 1,
    ...over,
  };
}

describe("whole-array drill attach", () => {
  it("keys by the drill URL's last segment when no row carries the join field", () => {
    expect(wholeArrayAttachKey(target(), { rows }, URL_)).toBe("reviews");
  });
  it("is null when a row carries the join field, or only one row exists", () => {
    expect(wholeArrayAttachKey(target(), { rows: [{ id: 1 }, { id: 2 }] }, URL_)).toBeNull();
    expect(wholeArrayAttachKey(target(), { rows: [{ stars: 1 }] }, URL_)).toBeNull();
  });
  it("emitter and shape inference agree", () => {
    const body = { items: [{ id: 1 }, { id: 2 }] };
    const key = wholeArrayAttachKey(target(), { rows }, URL_);
    const folded = foldOneDrillOccurrence(body, ["items"], ["id"], rows, body.items[0]!, key) as {
      items: Record<string, unknown>[];
    };
    expect(folded.items[0]).toEqual({ reviews: rows, id: 1 });
    expect(folded.items[1]).toEqual({ id: 2 });
    const lines = emitFoldMatchAndMergeLines(
      { varName: "r1", capture: { responseBody: { rows } } },
      target(),
      "item",
      "",
      (f) => `item.${f}`,
      key
    ).join("\n");
    expect(lines).toContain('"reviews"');
    expect(lines).not.toContain(".find(");
  });
  it("casts an array-root terminal via unknown", () => {
    const lines = emitFoldMatchAndMergeLines(
      { varName: "r1", capture: { responseBody: [{ id: 1 }, { id: 2 }] } },
      target({ chainArrayPath: [] }),
      "item",
      "",
      (f) => `item.${f}`
    ).join("\n");
    expect(lines).toContain("as unknown as Record<string, unknown>[]");
    expect(lines).not.toContain("r1 as Record<string, unknown>;");
  });
  it("does not attach a null answer", () => {
    const lines = emitFoldMatchAndMergeLines(
      { varName: "r1", capture: { responseBody: { rows } } },
      target(),
      "item",
      "",
      (f) => `item.${f}`,
      "reviews"
    ).join("\n");
    expect(lines).toContain("!= null");
  });
});

describe("isolated drills", () => {
  it("gates flagged drills and logs failures per drill", () => {
    const out = wrapIsolatedDrillLines(
      { payloadFlag: "includeReviews", attachAs: "reviews" },
      "reviews",
      "item",
      ["      await x();"]
    ).join("\n");
    expect(out).toContain('["includeReviews"]');
    expect(out).toContain("try {");
    expect(out).toContain("catch (error)");
    expect(out).toContain("getLogger(");
    expect(out).toContain("fold drill reviews failed");
  });
  it("leaves unflagged drills untouched", () => {
    const lines = ["x"];
    expect(wrapIsolatedDrillLines({}, "d", "item", lines)).toBe(lines);
  });
});

describe("drill and published schemas", () => {
  const cap = (responseBody: unknown) =>
    ({ url: "https://a.example/x/y", method: "GET", status: 200, responseBody }) as never;
  it("drill schema tolerates an empty answer verbatim", () => {
    const schema = inferChainStepResponseSchema(cap({ results: [{ a: 1 }], n: 2 }), [
      cap({ results: [{ a: 1 }], n: 2 }),
    ]);
    expect(schema).toContain("results: z.array(");
    expect(schema).toMatch(/n: z\.number\(\)\.nullable\(\)\.optional\(\)/);
    const empty = inferChainStepResponseSchema(cap({ results: [] }), [cap({ results: [] })]);
    expect(empty).toContain("results: z.array(z.unknown())");
  });
  it("published schema carries the fold-added attach key as optional", () => {
    const body = { items: [{ id: 1 }, { id: 2 }] };
    const folded = foldOneDrillOccurrence(body, ["items"], ["id"], rows, body.items[0]!, "reviews");
    const schema = inferZodSchemaFromSamples([folded], 0, "");
    expect(schema).toMatch(/reviews: z\.array\([\s\S]*?\)\)\.optional\(\)/);
    expect(schema).toMatch(/id: z\.number\(\),?\n/);
  });
});
