import { describe, expect, it } from "vitest";
import { z } from "zod/v4";

import { multipartBoolean, multipartJsonObject } from "@/lib/zod-multipart";

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

describe("multipartBoolean", () => {
  const BoolSchema = multipartBoolean();

  it("parses the string 'true' to boolean true", () => {
    const result = BoolSchema.safeParse("true");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(true);
  });

  it("parses the string 'false' to boolean false", () => {
    const result = BoolSchema.safeParse("false");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(false);
  });

  it("passes a real boolean through unchanged", () => {
    const result = BoolSchema.safeParse(true);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(true);
  });

  it("passes unrecognized values through unchanged (inner schema then rejects them)", () => {
    const result = BoolSchema.safeParse("yes");
    expect(result.success).toBe(false);
  });
});
