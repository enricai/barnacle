import { describe, expect, it } from "vitest";
import { z } from "zod/v4";

import { multipartJsonObject } from "@/lib/zod-multipart";

const InnerSchema = z.object({ foo: z.string() });
const WrappedSchema = multipartJsonObject(InnerSchema);

describe("multipartJsonObject", () => {
  it("passes a real object through to the inner schema", () => {
    const result = WrappedSchema.safeParse({ foo: "bar" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ foo: "bar" });
  });

  it("parses a JSON-encoded string into the inner schema", () => {
    const result = WrappedSchema.safeParse(JSON.stringify({ foo: "bar" }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ foo: "bar" });
  });

  it("passes an unparseable string through unchanged (inner schema then rejects it)", () => {
    const result = WrappedSchema.safeParse("not-json");
    expect(result.success).toBe(false);
  });
});
