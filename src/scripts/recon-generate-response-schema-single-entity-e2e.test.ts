import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import {
  emitContractTs,
  evaluateSingleEntityEvidence,
  gatherResponseBodySamples,
  inferChainStepResponseSchema,
} from "./recon-generate";

const BASE = {
  siteId: "demo-site",
  pascal: "DemoSite",
  baseUrl: "https://example.test",
  baseHeaders: { "Content-Type": "application/json" },
  minTime: 100,
  safeRps: 10,
  gql: false,
  gqlQuery: null,
  endpointPath: "/api/widgets/blue-widget",
  auxFiles: [],
};

const mk = (url: string, responseBody: unknown) =>
  ({ url, method: "GET", status: 200, responseBody }) as never;

const URL_A = "https://example.test/api/widgets/blue-widget?ids[]=100";
const URL_B = "https://example.test/api/widgets/blue-widget?ids[]=200";
const full = { id: 100, title: "t", price: 5, label: "x" };
const sibling = { id: 100, title: "t", price: 5, label: null };
const fullB = { id: 200, title: "u", price: 6, label: "y" };

function contractFor(captures: never[]): { src: string; warns: string[] } {
  const warns: string[] = [];
  const winning = captures[0]!;
  const { singleEntityEvidence } = evaluateSingleEntityEvidence(winning, false, captures, (m) =>
    warns.push(m)
  );
  const src = emitContractTs({
    ...BASE,
    responseBody: (winning as { responseBody: unknown }).responseBody,
    responseBodySamples: gatherResponseBodySamples(winning, false, captures),
    singleEntityEvidence,
  });
  return { src, warns };
}

function evalSchema(expr: string): z.ZodTypeAny {
  return new Function("z", `return ${expr};`)(z) as z.ZodTypeAny;
}

function responseSchemaExpr(src: string): string {
  const m = src.match(/export const DemoSiteResponseSchema = ([\s\S]*?);\s*export type /);
  expect(m).not.toBeNull();
  return m![1]!;
}

describe("single-entity response schema (e2e)", () => {
  it("same-id captures: WARN emitted and schema accepts a sibling body with a null scalar", () => {
    const { src, warns } = contractFor([mk(URL_A, full), mk(URL_A, full)]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/^WARN response schema inferred from a single entity/);
    expect(warns[0]).toContain("ids=100");
    const schema = evalSchema(responseSchemaExpr(src));
    expect(schema.safeParse(sibling).success).toBe(true);
    expect(schema.safeParse(full).success).toBe(true);
  });

  it("differing-id captures: no WARN and strict required scalar leaves are kept", () => {
    const { src, warns } = contractFor([mk(URL_A, full), mk(URL_B, fullB)]);
    expect(warns).toHaveLength(0);
    const schema = evalSchema(responseSchemaExpr(src));
    expect(schema.safeParse(full).success).toBe(true);
    expect(schema.safeParse(sibling).success).toBe(false);
  });

  it("unparameterized endpoint with several distinct responses: no WARN", () => {
    const u = "https://example.test/api/widgets";
    const { warns } = contractFor([mk(u, full), mk(u, fullB)]);
    expect(warns).toHaveLength(0);
  });

  it("unparameterized endpoint with one distinct response: WARN and a sibling with a null or omitted leaf validates", () => {
    const u = "https://example.test/api/widgets";
    const { src, warns } = contractFor([mk(u, full), mk(u, full)]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/^WARN response schema inferred from a single captured response/);
    const schema = evalSchema(responseSchemaExpr(src));
    expect(schema.safeParse(sibling).success).toBe(true);
    const { label: _omitted, ...omits } = full;
    expect(schema.safeParse(omits).success).toBe(true);
  });
});

describe("single-entity chain step schemas (e2e)", () => {
  it("same-id siblings: step schema accepts a null scalar", () => {
    const a = mk(URL_A, full);
    const schema = evalSchema(inferChainStepResponseSchema(a, [a, mk(URL_A, full)]));
    expect(schema.safeParse(sibling).success).toBe(true);
  });

  it("differing-id siblings: step schema keeps strict scalar leaves", () => {
    const a = mk(URL_A, full);
    const schema = evalSchema(inferChainStepResponseSchema(a, [a, mk(URL_B, fullB)]));
    expect(schema.safeParse(full).success).toBe(true);
    expect(schema.safeParse(sibling).success).toBe(false);
  });
});
