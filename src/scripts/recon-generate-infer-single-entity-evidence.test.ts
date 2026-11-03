import { describe, expect, it } from "vitest";
import { inferZodSchemaFromSamples } from "./recon-generate";

describe("inferZodSchemaFromSamples singleEntityEvidence", () => {
  const samples = [{ title: "a", tags: [{ n: 1 }, { n: 2 }] }];
  it("makes scalar leaves outside arrays nullable and optional; array elements unchanged", () => {
    const out = inferZodSchemaFromSamples(samples, 0, "", { singleEntityEvidence: true });
    expect(out).toContain("title: z.string().nullable().optional()");
    expect(out).toContain("n: z.number(),");
    expect(out).not.toContain("n: z.number().nullable()");
    expect(out).not.toContain("n: z.number().optional()");
  });
  it("is byte-identical to previous output when unset", () => {
    const out = inferZodSchemaFromSamples(samples);
    expect(out).toContain("title: z.string(),");
    expect(out).toBe(inferZodSchemaFromSamples(samples, 0, "", {}));
  });
});

describe("single-element arrays holding the captured entity", () => {
  it("keeps single-entity leniency for a lone element", () => {
    const out = inferZodSchemaFromSamples([{ rooms: [{ genre: "x" }] }], 0, "", { singleEntityEvidence: true });
    expect(out).toContain("genre: z.string().nullable().optional()");
  });
});
