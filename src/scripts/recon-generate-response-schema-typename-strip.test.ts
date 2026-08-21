import { describe, expect, it } from "vitest";
import { inferZodSchemaFromSamples } from "@/scripts/recon-generate";

describe("inferZodSchemaFromSamples — __typename structurally excluded at every depth", () => {
  it("drops a root-level __typename while keeping sibling fields typed", () => {
    const schema = inferZodSchemaFromSamples([{ __typename: "Widget", id: "abc" }], 0, "", {
      looseServerResponse: true,
    });
    expect(schema).not.toContain("__typename:");
    expect(schema).toContain("id: z.string()");
  });

  it("drops __typename one level deep inside a nested object", () => {
    const schema = inferZodSchemaFromSamples(
      [
        {
          widget: { __typename: "Widget", label: "x" },
        },
      ],
      0,
      "",
      { looseServerResponse: true }
    );
    expect(schema).not.toContain("__typename:");
    expect(schema).toContain("label: z.string()");
  });

  it("drops __typename inside an array of objects", () => {
    const schema = inferZodSchemaFromSamples(
      [
        {
          items: [
            { __typename: "Item", name: "a" },
            { __typename: "Item", name: "b" },
          ],
        },
      ],
      0,
      "",
      { looseServerResponse: true }
    );
    expect(schema).not.toContain("__typename:");
    expect(schema).toContain("name: z.string()");
  });

  it("drops __typename recurring at root, nested, and array-of-object levels in the same sample", () => {
    const schema = inferZodSchemaFromSamples(
      [
        {
          __typename: "Root",
          id: "r1",
          widget: { __typename: "Widget", label: "x" },
          items: [
            { __typename: "Item", name: "a" },
            { __typename: "Item", name: "b" },
          ],
        },
      ],
      0,
      "",
      { looseServerResponse: true }
    );
    expect(schema).not.toContain("__typename:");
    expect(schema).toContain("id: z.string()");
    expect(schema).toContain("label: z.string()");
    expect(schema).toContain("name: z.string()");
  });
});
