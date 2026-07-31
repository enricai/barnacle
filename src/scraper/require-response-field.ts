/**
 * Shared helpers for extracting required fields from already-parsed HTTP
 * response objects. Each plugin that calls createHttpClient receives a plain
 * object — these helpers standardise the "field must exist or throw" idiom so
 * every plugin surfaces the same HttpSchemaError shape and the log grep stays
 * stable across sites.
 */

import { HttpSchemaError } from "@/scraper/errors";

/**
 * Returns `obj[key]` cast to `T`. Throws {@link HttpSchemaError} when the
 * value is `null`, `undefined`, or the key is absent — with `contextLabel`
 * prefixed so the error is immediately actionable without additional wrapping.
 */
export function requireResponseField<T>(
  obj: Record<string, unknown>,
  key: string,
  contextLabel: string
): T {
  const value = obj[key];
  if (value === null || value === undefined) {
    throw new HttpSchemaError(`${contextLabel} missing ${key}`);
  }
  return value as T;
}

/**
 * Returns `resp.items[0][key]` cast to `T`. Throws {@link HttpSchemaError}
 * when `items` is absent or empty, or when the field itself is nullish.
 * Covers the Oracle HCM `?finder=...` pattern where results always arrive as
 * `{ items: [...] }` and the first element carries the required field.
 */
export function requireFirstItemField<T>(
  resp: { items?: Array<Record<string, unknown>> },
  key: string,
  contextLabel: string
): T {
  const first = resp.items?.[0];
  if (!first) {
    throw new HttpSchemaError(`${contextLabel} missing items`);
  }
  const value = first[key];
  if (value === null || value === undefined) {
    throw new HttpSchemaError(`${contextLabel} missing ${key}`);
  }
  return value as T;
}
