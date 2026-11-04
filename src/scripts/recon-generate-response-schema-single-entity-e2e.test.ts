import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import {
  emitContractTs,
  evaluateSingleEntityEvidence,
  gatherResponseBodySamples,
  inferChainStepResponseSchema,
  singleEntityVerdict,
  unreferencedRequiredUrlFields,
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

  it("unparameterized endpoint with several distinct responses and no identity variance: WARN, lenient", () => {
    const u = "https://example.test/api/widgets";
    const { src, warns } = contractFor([mk(u, full), mk(u, fullB)]);
    expect(warns).toHaveLength(1);
    expect(evalSchema(responseSchemaExpr(src)).safeParse(sibling).success).toBe(true);
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

describe("path-id endpoints with sibling null/omitted fields (e2e)", () => {
  const q = "ids[]=1&from=2024-01-01&to=2024-02-01";
  const P9 = `https://example.test/things/9/x?${q}`;
  const P10 = `https://example.test/things/10/x?${q}`;
  const body = {
    genre: "tools",
    description: null,
    owner: { name: "n" },
    tags: [{ label: "a" }],
  };

  it("single-entity capture: sibling with null scalar, null object and omitted array validates", () => {
    const { src, warns } = contractFor([mk(P9, body), mk(P9, body)]);
    expect(warns).toHaveLength(1);
    const schema = evalSchema(responseSchemaExpr(src));
    expect(schema.safeParse(body).success).toBe(true);
    expect(schema.safeParse({ genre: null, description: null, owner: null }).success).toBe(true);
    expect(schema.safeParse({ genre: "x", description: "d", owner: { name: "m" } }).success).toBe(
      true
    );
  });

  it("different path ids: no WARN and the strict schema rejects a null scalar", () => {
    const other = { ...body, genre: "toys" };
    const { src, warns } = contractFor([mk(P9, body), mk(P10, other)]);
    expect(warns).toHaveLength(0);
    const schema = evalSchema(responseSchemaExpr(src));
    expect(schema.safeParse(body).success).toBe(true);
    expect(schema.safeParse({ ...body, genre: null }).success).toBe(false);
  });
});

describe("venue schedule endpoint, date-window-only variance (e2e)", () => {
  const W1 = "from=2024-01-01&to=2024-01-31";
  const W2 = "from=2024-02-01&to=2024-02-28";
  const fantasy = { id: 1, name: "n", genre: "Fantasy", slots: [{ at: "t" }] };
  const nullGenre = { id: 1, name: "n", genre: null, slots: [{ at: "t" }] };
  const noGenre = { id: 1, name: "n", slots: [{ at: "t" }] };
  const body2 = { ...fantasy, name: "m" };
  const u = (p: string) => `https://example.test${p}`;

  function expectLenient(caps: never[], warnCount = 1) {
    const { src, warns } = contractFor(caps);
    expect(warns).toHaveLength(warnCount);
    const schema = evalSchema(responseSchemaExpr(src));
    expect(schema.safeParse(fantasy).success).toBe(true);
    expect(schema.safeParse(nullGenre).success).toBe(true);
    expect(schema.safeParse(noGenre).success).toBe(true);
  }

  it("numeric path id + ids[] query varying only the date window: lenient", () => {
    expectLenient([
      mk(u(`/venues/7/schedule?ids[]=7&${W1}`), fantasy),
      mk(u(`/venues/7/schedule?ids[]=7&${W2}`), body2),
    ]);
  });

  it("slug path segment with no id query: lenient", () => {
    expectLenient([
      mk(u("/venues/grand-hall/schedule"), fantasy),
      mk(u("/venues/grand-hall/schedule"), body2),
    ]);
  });

  it("slug path with page/limit window: lenient", () => {
    expectLenient([
      mk(u("/venues/grand-hall/schedule?page=1&limit=10"), fantasy),
      mk(u("/venues/grand-hall/schedule?page=2&limit=10"), body2),
    ]);
  });

  it("slug path plus slug-valued ids[] query: lenient", () => {
    expectLenient([
      mk(u(`/venues/grand-hall/schedule?ids[]=grand-hall&${W1}`), fantasy),
      mk(u(`/venues/grand-hall/schedule?ids[]=grand-hall&${W2}`), body2),
    ]);
  });

  it("no identifying params, two distinct bodies: lenient", () => {
    expectLenient([mk(u("/schedule"), fantasy), mk(u("/schedule"), body2)]);
  });

  it("differing path ids (9 vs 10) stay strict", () => {
    const { src, warns } = contractFor([
      mk(u(`/venues/9/schedule?${W1}`), fantasy),
      mk(u(`/venues/10/schedule?${W1}`), { ...fantasy, id: 10, genre: "Drama" }),
    ]);
    expect(warns).toHaveLength(0);
    const schema = evalSchema(responseSchemaExpr(src));
    expect(schema.safeParse(nullGenre).success).toBe(false);
  });

  it("chain step: date-window-only siblings lenient; lone sample and unparameterized repeats lenient", () => {
    const a = mk(u(`/venues/7/schedule?ids[]=7&${W1}`), fantasy);
    const b = mk(u(`/venues/7/schedule?ids[]=7&${W2}`), body2);
    const lenient = evalSchema(inferChainStepResponseSchema(a, [a, b]));
    expect(lenient.safeParse(nullGenre).success).toBe(true);
    const solo = mk(u("/schedule"), fantasy);
    const lone = evalSchema(inferChainStepResponseSchema(solo, [solo]));
    expect(lone.safeParse(fantasy).success).toBe(true);
    expect(lone.safeParse(nullGenre).success).toBe(true);
    const r1 = mk(u("/schedule"), fantasy);
    const r2 = mk(u("/schedule"), body2);
    const repeats = evalSchema(inferChainStepResponseSchema(r1, [r1, r2]));
    expect(repeats.safeParse(nullGenre).success).toBe(true);
  });
});

describe("bookstore catalog item, id in path and bracketed query, repeated across date windows (e2e)", () => {
  const W1 = "from=2024-01-01&to=2024-01-31";
  const W2 = "from=2024-02-01&to=2024-02-28";
  const item = (p: string) => `https://example.test/catalog/items/42/sales?ids[]=42&${p}`;
  const captured = {
    id: 42,
    title: "Dune",
    category: "scifi",
    coverUrl: "https://example.test/c.png",
    discount: null,
    note: null,
  };
  const sibNullCat = { ...captured, category: null };
  const { category: _c, ...sibNoCat } = captured;

  it("primary schema accepts sibling with the string field null or absent", () => {
    const { src } = contractFor([mk(item(W1), captured), mk(item(W2), { ...captured, id: 42 })]);
    const schema = evalSchema(responseSchemaExpr(src));
    expect(schema.safeParse(captured).success).toBe(true);
    expect(schema.safeParse(sibNullCat).success).toBe(true);
    expect(schema.safeParse(sibNoCat).success).toBe(true);
  });

  it("chain step schema accepts the same siblings", () => {
    const a = mk(item(W1), captured);
    const schema = evalSchema(inferChainStepResponseSchema(a, [a, mk(item(W2), captured)]));
    expect(schema.safeParse(sibNullCat).success).toBe(true);
    expect(schema.safeParse(sibNoCat).success).toBe(true);
  });

  it("lone sample and submission-terminal emission accept the siblings", () => {
    const one = mk(item(W1), captured);
    const lone = contractFor([one]);
    expect(evalSchema(responseSchemaExpr(lone.src)).safeParse(sibNullCat).success).toBe(true);
    const terminal = emitContractTs({
      ...BASE,
      responseBody: captured,
      responseBodySamples: [captured],
      singleEntityEvidence: singleEntityVerdict(null, false, 1, null),
    });
    const schema = evalSchema(responseSchemaExpr(terminal));
    expect(schema.safeParse(sibNullCat).success).toBe(true);
    expect(schema.safeParse(sibNoCat).success).toBe(true);
  });

  it("a required *Url response leaf does not trip the required-URL-field guard", () => {
    const { src } = contractFor([mk(item(W1), captured), mk(item(W2), captured)]);
    expect(src).toContain("coverUrl");
    expect(unreferencedRequiredUrlFields(src, "", true)).toEqual([]);
  });

  it("multi-entity captures stay strict", () => {
    const other = { ...captured, id: 43, title: "Emma", category: "classic" };
    const { src, warns } = contractFor([
      mk(item(W1), captured),
      mk("https://example.test/catalog/items/43/sales?ids[]=43&" + W1, other),
    ]);
    expect(warns).toHaveLength(0);
    expect(evalSchema(responseSchemaExpr(src)).safeParse(sibNullCat).success).toBe(false);
  });
});
