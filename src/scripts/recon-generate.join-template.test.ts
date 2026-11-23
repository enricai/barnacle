import { describe, expect, it } from "vitest";
import { RECON_FLOW_FILE_SCHEMA } from "@/scripts/recon-browser";
import {
  emitJoinTemplateExpr,
  evalJoinTemplate,
  joinTemplateFields,
  parseFoldReturnSpec,
  parseJoinTemplate,
} from "@/scripts/recon-generate";

const flow = (entry: Record<string, unknown>): string =>
  JSON.stringify({ steps: [{ step: "x" }], foldReturn: entry });
const base = { endpointPattern: "/detail", resultsPath: "a.b" };

describe("foldReturn joinTemplate", () => {
  it("composes the drill key per row with a date token", () => {
    const tokens = parseJoinTemplate("{ship}{start|yyMMdd}{pkg}")!;
    expect(
      evalJoinTemplate(tokens, {
        ship: "AB",
        start: "2025-03-07T00:00:00Z",
        pkg: "P1",
      })
    ).toBe("AB250307P1");
    expect(evalJoinTemplate(tokens, { ship: "CD", start: "2026-11-02", pkg: "P2" })).toBe(
      "CD261102P2"
    );
    expect(evalJoinTemplate(tokens, { ship: "CD", pkg: "P2" })).toBeUndefined();
  });

  it("emitted expression agrees with the evaluator", () => {
    const tokens = parseJoinTemplate("{ship}-{start|yyyyMMdd}")!;
    const expr = emitJoinTemplateExpr(tokens, (f) => `item[${JSON.stringify(f)}]`);
    const run = new Function(
      "item",
      `return ${expr.replace(/: (unknown|number \| undefined|string \| number)/g, "").replace(/ as string \| number/g, "")};`
    );
    const item = { ship: "AB", start: "2025-03-07" };
    expect(run(item)).toBe(evalJoinTemplate(tokens, item));
  });

  it("rejects malformed templates", () => {
    expect(parseJoinTemplate("{a")).toBeNull();
    expect(parseJoinTemplate("plain")).toBeNull();
    expect(parseJoinTemplate("{a|bogus}")).toBeNull();
  });

  it("parses joinTemplate and keeps joinFields-only flows unchanged", () => {
    const withT = parseFoldReturnSpec(
      flow({ ...base, joinFields: ["ship"], joinTemplate: "{ship}{d|yyMMdd}" })
    );
    expect(withT?.joinTemplate).toBe("{ship}{d|yyMMdd}");
    const derived = parseFoldReturnSpec(flow({ ...base, joinTemplate: "{ship}{d|yyMMdd}" }));
    expect(derived?.joinFields).toEqual(["ship", "d"]);
    const plain = parseFoldReturnSpec(flow({ ...base, joinFields: ["id"] }));
    expect(plain).toEqual({ ...base, joinFields: ["id"] });
    expect(
      parseFoldReturnSpec(flow({ ...base, joinFields: ["id"], joinTemplate: "{a" }))
    ).toBeNull();
  });

  it("schema accepts joinTemplate and still requires a join key", () => {
    const ok = RECON_FLOW_FILE_SCHEMA.safeParse({
      steps: [{ step: "x", optional: false, upload: false }],
      foldReturn: { ...base, joinTemplate: "{a}{b}" },
    });
    expect(ok.success).toBe(true);
    const bad = RECON_FLOW_FILE_SCHEMA.safeParse({
      steps: [{ step: "x", optional: false, upload: false }],
      foldReturn: base,
    });
    expect(bad.success).toBe(false);
  });

  it("handles dotted paths, numbers, epoch dates and bad inputs", () => {
    const tokens = parseJoinTemplate("{a.id}/{n}/{t|yyyy-MM-dd HH:mm:ss}")!;
    expect(joinTemplateFields(tokens)).toEqual(["a.id", "n", "t"]);
    expect(evalJoinTemplate(tokens, { a: { id: "X" }, n: 5, t: 0 })).toBe(
      "X/5/1970-01-01 00:00:00"
    );
    expect(evalJoinTemplate(tokens, { a: { id: "X" }, n: 5, t: "nope" })).toBeUndefined();
    expect(evalJoinTemplate(tokens, { a: { id: "X" }, n: {}, t: 0 })).toBeUndefined();
    expect(parseJoinTemplate("a}{b}")).toBeNull();
    expect(parseJoinTemplate("{}")).toBeNull();
    expect(parseJoinTemplate("{a|yy|dd}")).toBeNull();
    expect(parseFoldReturnSpec(flow({ ...base, joinTemplate: 5 }))).toBeNull();
  });
});
