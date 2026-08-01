import { toJsonSchema } from "@browserbasehq/stagehand/lib/v3/zodCompat.js";
import { describe, expect, it } from "vitest";
import { type ZodTypeAny, z as z3 } from "zod";
import { z as z4 } from "zod/v4";

describe("stagehand zodCompat patch", () => {
  it("converts a zod/v4 schema to JSON schema without throwing", () => {
    const schema = z4.object({ name: z4.string(), age: z4.number() });

    const jsonSchema = toJsonSchema(schema as unknown as ZodTypeAny) as {
      properties?: Record<string, unknown>;
    };

    expect(jsonSchema.properties).toHaveProperty("name");
    expect(jsonSchema.properties).toHaveProperty("age");
  });

  it("still converts a zod v3 schema via the zod-to-json-schema fallback", () => {
    const schema = z3.object({ label: z3.string() });

    const jsonSchema = toJsonSchema(schema) as { properties?: Record<string, unknown> };

    expect(jsonSchema.properties).toHaveProperty("label");
  });
});
