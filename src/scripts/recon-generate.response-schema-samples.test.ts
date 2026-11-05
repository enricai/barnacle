import { describe, expect, it } from "vitest";
import {
  emptyArrayOnlySample,
  gatherResponseBodySamples,
  inferChainStepResponseSchema,
} from "./recon-generate.js";

const cap = (url: string, body: unknown, status = 200) =>
  ({ url, method: "GET", status, responseBody: body, requestHeaders: {} }) as never;

describe("response schema samples", () => {
  it("skips null bodies", () => {
    const a = cap("https://x.test/api/products", { items: [{ id: 1 }] });
    const b = cap("https://x.test/api/products", null);
    expect(gatherResponseBodySamples(a, false, [a, b])).toEqual([{ items: [{ id: 1 }] }]);
  });
  it("emptyArrayOnlySample keeps only emptied arrays", () => {
    expect(emptyArrayOnlySample({ n: 1, results: [{ a: 1 }] })).toEqual({ results: [] });
    expect(emptyArrayOnlySample(null)).toBeNull();
  });
  it("drill schema accepts empty results and marks siblings optional", () => {
    const a = cap("https://x.test/api/products", { total: 2, results: [{ sku: "a" }] });
    const schema = inferChainStepResponseSchema(a, [a]);
    expect(schema).toContain("z.array(");
    expect(schema).toMatch(/total: z\.number\(\)[^\n]*optional\(\)/);
  });
});
