import { describe, expect, it } from "vitest";
import { type FoldReturnSpec, resolveFoldPlan } from "@/scripts/recon-generate";
import { buildStep, type MulticallFixtureStep } from "@/scripts/recon-generate-multicall-fixture";

const BASE = "https://api.example.com";
const PRIMARY: FoldReturnSpec = {
  endpointPattern: "/prices/",
  resultsPath: "results",
  joinFields: ["sku"],
};
const EXTRA: FoldReturnSpec = {
  endpointPattern: "/stock/",
  resultsPath: "results",
  joinFields: ["sku"],
};
const ts = (i: number): string => `2024-11-01T00:00:${String(i).padStart(2, "0")}.000Z`;
const step = (
  name: string,
  i: number,
  path: string,
  req: unknown,
  res: unknown
): MulticallFixtureStep =>
  buildStep(name, {
    url: `${BASE}${path}`,
    requestPostData: JSON.stringify(req),
    responseBody: res,
    timestamp: ts(i),
  });

const search = step("s", 0, "/search/", { q: 1 }, { results: [{ sku: "a1" }, { sku: "b2" }] });
const prices = step("p", 1, "/prices/", { sku: "a1" }, { prices: [{ sku: "a1", amount: 5 }] });
const stock = step("k", 2, "/stock/", { sku: "a1" }, { stock: [{ sku: "a1", qty: 3 }] });

describe("resolveFoldPlan with several drills", () => {
  it("primary drill plan equals the single-drill plan", () => {
    const single = resolveFoldPlan([search, prices], PRIMARY);
    const multi = resolveFoldPlan([search, prices, stock], PRIMARY, null, [EXTRA]);
    expect(multi[0]?.targets[0]).toEqual(single[0]?.targets[0]);
    expect(multi[0]?.targets).toHaveLength(2);
    expect(multi[0]?.targets[1]?.chainTerminalIndex).toBe(2);
  });

  it("extra drill terminal is its own endpoint step despite a later dependent hop", () => {
    const stockWithToken = step(
      "k",
      2,
      "/stock/",
      { sku: "a1" },
      { stock: [{ sku: "a1" }], token: "tok-9f8e7d6c5b4a" }
    );
    const later = step(
      "l",
      3,
      "/ledger/",
      { token: "tok-9f8e7d6c5b4a" },
      { rows: [{ sku: "a1", qty: 3, note: "x", extra: "y" }] }
    );
    const plans = resolveFoldPlan([search, prices, stockWithToken, later], PRIMARY, null, [EXTRA]);
    const extraTarget = plans[0]?.targets.find((t) => t.drillStepIndex === 2);
    expect(extraTarget?.chainTerminalIndex).toBe(2);
  });

  it("collapses structural and declared targets on one endpoint to the declared one", () => {
    const deep = step(
      "p",
      1,
      "/prices/",
      { sku: "a1" },
      { detail: { items: [{ sku: "a1", amount: 5, tags: [{ t: 1 }] }] } }
    );
    const spec: FoldReturnSpec = { ...PRIMARY, drillResultsPath: "detail.items" };
    const plans = resolveFoldPlan([search, deep], spec);
    const onEndpoint = plans[0]?.targets.filter((t) => t.chainTerminalIndex === 1);
    expect(onEndpoint).toHaveLength(1);
    expect(onEndpoint?.[0]?.chainArrayPath).toEqual(["detail", "items"]);
  });

  it("drops a structural ancestor target when the declared drill path is a nested array", () => {
    const deep = step(
      "p",
      1,
      "/prices/",
      { sku: "a1" },
      { detail: { items: [{ sku: "a1", amount: 5, tags: [{ sku: "a1", t: 1 }] }] } }
    );
    const spec: FoldReturnSpec = { ...PRIMARY, drillResultsPath: "detail.items.tags" };
    const plans = resolveFoldPlan([search, deep], spec);
    const onEndpoint = plans[0]?.targets.filter((t) => t.chainTerminalIndex === 1);
    expect(onEndpoint).toHaveLength(1);
    expect(onEndpoint?.[0]?.chainArrayPath).toEqual(["detail", "items", "*", "tags"]);
  });
});
