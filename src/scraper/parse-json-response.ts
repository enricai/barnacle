/**
 * Shared JSON-parse + Zod-validate seam for rawFetch callers. Each plugin
 * that builds on rawFetch needs this identical two-step (JSON.parse, then
 * schema.safeParse) — extracting it here prevents subtle divergence in error
 * message shapes and slice constants across plugins.
 */

import type { ZodType } from "zod/v4";

import { toErrorMessage } from "@/lib/errors";
import { HttpSchemaError, HttpUrlLockedError } from "@/scraper/errors";
import { classifyOracleSentinel } from "@/scraper/oracle-sentinels";

/**
 * Parses `rawBody` as JSON, validates it against `schema`, and returns the
 * narrowed result. Throws {@link HttpUrlLockedError} when the body is a locked
 * Oracle sentinel (ORA_URL_LOCKED). Throws {@link HttpSchemaError} on other
 * JSON parse failures or Zod schema mismatches, with `contextLabel` prefixed so
 * error messages are immediately actionable in logs without additional wrapping.
 */
export function parseJsonResponse<T>(rawBody: string, schema: ZodType<T>, contextLabel: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch (err) {
    if (classifyOracleSentinel(rawBody) === "locked") {
      throw new HttpUrlLockedError();
    }
    throw new HttpSchemaError(
      `${contextLabel} non-JSON body: ${toErrorMessage(err)} (first 200B: ${rawBody.slice(0, 200)})`
    );
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new HttpSchemaError(
      `${contextLabel} body failed Zod parse: ${result.error.message.slice(0, 300)}`
    );
  }

  return result.data;
}
