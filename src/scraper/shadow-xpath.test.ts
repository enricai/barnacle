import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SHADOW_XPATH_ALL_RESOLVER_SRC, SHADOW_XPATH_RESOLVER_SRC } from "@/scraper/shadow-xpath";

// happy-dom has no XPath engine, so document.evaluate is stubbed: it answers
// per (expression, context node) from a table, which is enough to pin the
// resolver's segment-walking and shadow-root traversal.
type Node = {
  nodeType: number;
  shadowRoot?: Node;
  children: Node[];
  id?: string;
  querySelectorAll: () => Node[];
};
const node = (id: string, nodeType = 1, children: Node[] = []): Node => ({
  id,
  nodeType,
  children,
  querySelectorAll: () => children,
});

function resolver(table: Map<string, Node[]>, doc: Node, src = SHADOW_XPATH_RESOLVER_SRC) {
  const evaluate = (expr: string, ctx: Node) => {
    const hits = table.get(`${expr}@${ctx.id}`) ?? [];
    return {
      singleNodeValue: hits[0] ?? null,
      snapshotLength: hits.length,
      snapshotItem: (i: number) => hits[i],
    };
  };
  const fn = new Function("document", "XPathResult", `return ${src};`);
  return fn(
    { ...doc, evaluate },
    { FIRST_ORDERED_NODE_TYPE: 9, ORDERED_NODE_SNAPSHOT_TYPE: 7 }
  ) as (x: string) => Node | null;
}

describe("shadow-aware xpath resolver", () => {
  it("crosses an open shadow root at a '//' segment", () => {
    const button = node("buy");
    const section = node("section", 1, [button]);
    const root = node("root", 11, [section]);
    const host = node("host");
    host.shadowRoot = root;
    const doc = node("doc", 9, [host]);
    const table = new Map<string, Node[]>([
      ["//shop-app@doc", [host]],
      ['.//button[@id="buy"]@section', [button]],
    ]);
    // resolver's `document` must be the same object the table keys on
    const r = resolver(table, doc);
    expect(r('//shop-app//button[@id="buy"]')?.id).toBe("buy");
  });

  it("returns the native light-DOM result untouched", () => {
    const a = node("a");
    const doc = node("doc", 9);
    const r = resolver(new Map([['//button[@id="a"]@doc', [a]]]), doc);
    expect(r('//button[@id="a"]')).toBe(a);
  });

  it("flow-runner has no raw document.evaluate first-node xpath lookup left", () => {
    const src = readFileSync(join(process.cwd(), "src/scraper/flow-runner.ts"), "utf8");
    expect(src).not.toMatch(/document\.evaluate\([^)]*FIRST_ORDERED_NODE_TYPE/);
  });

  it("snapshot variant finds shadow matches only when native finds none", () => {
    const button = node("buy");
    const section = node("section", 1, [button]);
    const root = node("root", 11, [section]);
    const host = node("host");
    host.shadowRoot = root;
    const doc = node("doc", 9, [host]);
    const table = new Map<string, Node[]>([
      ["//shop-app@doc", [host]],
      ['.//button[@id="buy"]@section', [button]],
    ]);
    const all = resolver(table, doc, SHADOW_XPATH_ALL_RESOLVER_SRC) as unknown as (
      x: string
    ) => Node[];
    expect(all('//shop-app//button[@id="buy"]').map((n) => n.id)).toEqual(["buy"]);
    expect(all("//nope//x")).toEqual([]);
    const a = node("a");
    const b = node("b");
    const light = resolver(
      new Map([["//button@doc", [a, b]]]),
      node("doc", 9),
      SHADOW_XPATH_ALL_RESOLVER_SRC
    ) as unknown as (x: string) => Node[];
    expect(light("//button")).toEqual([a, b]);
  });
});
