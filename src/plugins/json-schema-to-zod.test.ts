import { describe, expect, it } from "vitest";

import { jsonSchemaToZod, UnsupportedJsonSchemaError } from "@/plugins/json-schema-to-zod";

describe("jsonSchemaToZod", () => {
  it("produces an instance that duck-types as a Zod schema", () => {
    const schema = jsonSchemaToZod({ type: "string" });
    expect(typeof schema.safeParse).toBe("function");
    expect(typeof schema.parse).toBe("function");
  });

  it("enforces required object fields and allows optional ones to be omitted", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      required: ["FirstName", "Email"],
      properties: {
        FirstName: { type: "string" },
        Email: { type: "string" },
        Phone: { type: "string" },
      },
    });
    expect(schema.safeParse({ FirstName: "Jane", Email: "j@x.com" }).success).toBe(true);
    expect(schema.safeParse({ Email: "j@x.com" }).success).toBe(false);
  });

  it("rejects wrong-typed and out-of-enum values", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      required: ["Name", "Mode"],
      properties: {
        Name: { type: "string" },
        Mode: { type: "string", enum: ["a", "b"] },
      },
    });
    expect(schema.safeParse({ Name: 123, Mode: "a" }).success).toBe(false);
    expect(schema.safeParse({ Name: "x", Mode: "z" }).success).toBe(false);
    expect(schema.safeParse({ Name: "x", Mode: "b" }).success).toBe(true);
  });

  it("converts arrays with typed items", () => {
    const schema = jsonSchemaToZod({ type: "array", items: { type: "string" } });
    expect(schema.safeParse(["a", "b"]).success).toBe(true);
    expect(schema.safeParse([1]).success).toBe(false);
  });

  it("survives a JSON round-trip (manifest is JSON on disk)", () => {
    const raw = JSON.parse(
      JSON.stringify({ type: "object", required: ["A"], properties: { A: { type: "string" } } })
    );
    const schema = jsonSchemaToZod(raw);
    expect(schema.safeParse({ A: "x" }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it("throws UnsupportedJsonSchemaError on an unknown type", () => {
    expect(() => jsonSchemaToZod({ type: "geometry" })).toThrow(UnsupportedJsonSchemaError);
  });

  it("throws UnsupportedJsonSchemaError on unknown keys (strict)", () => {
    expect(() => jsonSchemaToZod({ type: "string", pattern: "^x$" })).toThrow(
      UnsupportedJsonSchemaError
    );
  });
});
