import { z } from "zod/v4";

/**
 * Multipart bodies can't nest objects, so an object-shaped field on a
 * payload schema needs to accept either the real object (from `dispatch()`
 * callers that bypass the multipart parser) or a JSON-encoded string (from
 * curl `-F 'Field={...}'` callers). This preprocessor unifies both into
 * the object shape the inner schema validates. Unparseable strings are
 * passed through as-is so the inner schema produces the right validation error.
 */
export function multipartJsonObject<T extends z.ZodTypeAny>(innerSchema: T): z.ZodType<z.infer<T>> {
  return z.preprocess((v) => {
    if (typeof v !== "string") return v;
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }, innerSchema) as z.ZodType<z.infer<T>>;
}

/**
 * Multipart form fields serialize booleans as the strings 'true'/'false'.
 * Accepts real booleans as-is (from dispatch() callers that bypass the
 * multipart parser). Unrecognized values are passed through so z.boolean()
 * produces the right validation error.
 */
export function multipartBoolean(): z.ZodType<boolean> {
  return z.preprocess(
    (v) => (v === "true" ? true : v === "false" ? false : v),
    z.boolean()
  ) as z.ZodType<boolean>;
}
