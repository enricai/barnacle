import type { Action } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";

import { verifyDomEffect } from "@/scraper/flow-runner";
import type { FrameTarget } from "@/scraper/frame-target";
import { shadowXpathLookupExpr } from "@/scraper/shadow-xpath";

const XPATH = "/html[1]/body[1]/shop-app[1]";
const SELECTOR = `xpath=${XPATH}`;

/** Fake page whose document.evaluate records every xpath the in-page resolver asks for. */
function makeTarget() {
  const asked: string[] = [];
  const el = {
    tagName: "SELECT",
    type: "checkbox",
    disabled: false,
    selectedIndex: 0,
    options: [{ value: "v", label: "L", textContent: "T" }],
    getAttribute: () => null,
    hasAttribute: () => false,
    closest: () => null,
    querySelectorAll: () => [],
    children: [],
  };
  const doc = {
    evaluate: (expr: string) => {
      asked.push(expr);
      return { singleNodeValue: el, snapshotLength: 1, snapshotItem: () => el };
    },
  };
  const exprs: string[] = [];
  const evaluate = vi.fn(async (expr: string) => {
    exprs.push(expr);
    return new Function("document", "XPathResult", `return ${expr};`)(doc, {
      FIRST_ORDERED_NODE_TYPE: 9,
      ORDERED_NODE_SNAPSHOT_TYPE: 7,
    });
  });
  const target = {
    frame: {} as FrameTarget["frame"],
    frameSelector: null,
    evaluate: evaluate as unknown as FrameTarget["evaluate"],
    locator: (() => ({
      first: () => ({
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue(""),
        selectOption: vi.fn(),
      }),
    })) as unknown as FrameTarget["locator"],
    url: () => Promise.resolve("https://x.example/"),
    title: () => Promise.resolve("t"),
  } as FrameTarget;
  return { target, asked, exprs };
}

describe("flow-runner xpath call sites route through the shadow resolver", () => {
  it("selectOption verification resolves its xpath via the resolver", async () => {
    const { target, asked } = makeTarget();
    const action = {
      selector: SELECTOR,
      method: "selectOption",
      arguments: ["T"],
    } as unknown as Action;
    expect(await verifyDomEffect(target, action)).toBe(true);
    expect(asked).toContain(XPATH);
  });

  it("click verification resolves disabled/type/aria/fingerprint probes via the resolver", async () => {
    const { target, asked, exprs } = makeTarget();
    const action = { selector: SELECTOR, method: "click", arguments: [] } as unknown as Action;
    await verifyDomEffect(target, action);
    expect(exprs.length).toBeGreaterThan(1);
    expect(asked.length).toBeGreaterThan(1);
    expect(new Set(asked)).toEqual(new Set([XPATH]));
  });
});

describe("shadowXpathLookupExpr", () => {
  it("embeds the resolver applied to a JSON-escaped xpath and evaluates", () => {
    const xp = '//a[@t="q\\"x"]';
    const expr = shadowXpathLookupExpr(xp);
    expect(expr.endsWith(`(${JSON.stringify(xp)})`)).toBe(true);
    const el = { id: "hit" };
    const doc = { evaluate: () => ({ singleNodeValue: el }) };
    expect(
      new Function("document", "XPathResult", `return ${expr};`)(doc, {
        FIRST_ORDERED_NODE_TYPE: 9,
      })
    ).toBe(el);
  });
});
