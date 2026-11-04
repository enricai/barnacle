import { describe, expect, it } from "vitest";
import { z } from "zod/v4";

import { gatherEntityVarianceEvidence, inferZodSchemaFromSamples } from "@/scripts/recon-generate";
import type { Capture } from "@/scripts/recon-shared";

function evalSchema(expr: string): z.ZodType {
  return new Function("z", `return ${expr};`)(z) as z.ZodType;
}

describe("inferZodSchemaFromSamples singleEntityEvidence — evaluated schema", () => {
  // One catalog entity; `genre` is a string here and the sibling object
  // carries it as a null-valued string-typed field.
  const sample = {
    product: { title: "Widget", genre: "tools", tags: [{ label: "a" }, { label: "b" }] },
  };
  const schema = evalSchema(
    inferZodSchemaFromSamples([sample], 0, "", { singleEntityEvidence: true })
  );

  it('accepts the report\'s literal `"genre": null` on a sibling body', () => {
    const sibling = JSON.parse(
      '{"product":{"title":"Gadget","genre": null,"tags":[{"label":"x"}]}}'
    );
    expect(schema.safeParse(sibling).success).toBe(true);
  });

  it("accepts an absent scalar field", () => {
    expect(schema.safeParse({ product: { title: "Gadget", tags: [] } }).success).toBe(true);
  });

  it("keeps leniency for array elements and non-scalar properties", () => {
    expect(schema.safeParse({ product: { title: "G", tags: [{}] } }).success).toBe(true);
    expect(schema.safeParse({ product: { title: "G", tags: [{ label: null }] } }).success).toBe(
      true
    );
    expect(schema.safeParse({ product: { title: "G", tags: null } }).success).toBe(true);
    expect(schema.safeParse({ product: null }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(true);
  });

  it("still rejects a wrong scalar type", () => {
    expect(schema.safeParse({ product: { title: 5 } }).success).toBe(false);
  });

  it("option off: output is unchanged and strict", () => {
    const off = inferZodSchemaFromSamples([sample]);
    expect(off).toBe(inferZodSchemaFromSamples([sample], 0, "", { singleEntityEvidence: false }));
    expect(off).not.toContain(".nullable()");
    expect(off).not.toContain(".optional()");
    const strict = evalSchema(off);
    expect(strict.safeParse({ product: { title: "G", genre: null, tags: [] } }).success).toBe(
      false
    );
  });
});

describe("gatherEntityVarianceEvidence — catalog scenarios", () => {
  const cap = (url: string, status = 200): Capture => ({
    timestamp: "2024-01-01T00:00:00Z",
    phase: "action",
    method: "GET",
    url,
    status,
    requestHeaders: {},
    requestPostData: null,
    responseHeaders: {},
    responseBody: {},
    operationName: null,
    query: null,
    variables: null,
    decodedParams: null,
  });
  const base = "https://shop.example.com/api/products";

  it("shared id across captures -> single entity", () => {
    const w = cap(`${base}?productId=7&page=1`);
    const r = gatherEntityVarianceEvidence(w, false, [w, cap(`${base}?productId=7&page=2`)]);
    expect(r.entityParameterized).toBe(true);
    expect(r.singleEntity).toBe(true);
  });

  it("varying id -> not single entity", () => {
    const w = cap(`${base}?productId=7`);
    const r = gatherEntityVarianceEvidence(w, false, [w, cap(`${base}?productId=8`)]);
    expect(r.entityParameterized).toBe(true);
    expect(r.singleEntity).toBe(false);
  });

  it("no id -> not parameterized", () => {
    const w = cap(`${base}?page=1`);
    expect(gatherEntityVarianceEvidence(w, false, [w]).entityParameterized).toBe(false);
  });

  it("slug path with no identifying params -> not parameterized, single entity (absence of variance)", () => {
    const slug = "https://shop.example.com/api/widgets/blue-widget";
    const w = cap(slug);
    const r = gatherEntityVarianceEvidence(w, false, [w, cap(slug)]);
    expect(r.entityParameterized).toBe(false);
    expect(r.params).toEqual({});
    expect(r.singleEntity).toBe(true);
  });

  it("date window varying with a shared id query -> single entity", () => {
    const w = cap(`${base}?ids[]=100&from=2024-01-01&to=2024-01-31`);
    const r = gatherEntityVarianceEvidence(w, false, [
      w,
      cap(`${base}?ids[]=100&from=2024-02-01&to=2024-02-28`),
    ]);
    expect(r.entityParameterized).toBe(true);
    expect(r.params).toEqual({ ids: "100" });
    expect(r.singleEntity).toBe(true);
  });

  it("date window with a varying id query -> multi-entity", () => {
    const w = cap(`${base}?ids[]=100&from=2024-01-01`);
    const r = gatherEntityVarianceEvidence(w, false, [w, cap(`${base}?ids[]=200&from=2024-01-01`)]);
    expect(r.singleEntity).toBe(false);
  });

  it("GraphQL winner -> not parameterized", () => {
    const w = cap(`${base}?productId=7`);
    expect(gatherEntityVarianceEvidence(w, true, [w]).entityParameterized).toBe(false);
  });

  it("path ids differing across captures -> multi-entity", () => {
    const t = "https://example.test/things";
    const w = cap(`${t}/9/x?ids[]=1&from=2024-01-01&to=2024-02-01`);
    const r = gatherEntityVarianceEvidence(w, false, [
      w,
      cap(`${t}/10/x?ids[]=1&from=2024-01-01&to=2024-02-01`),
    ]);
    expect(r.entityParameterized).toBe(true);
    expect(r.singleEntity).toBe(false);
  });
});
