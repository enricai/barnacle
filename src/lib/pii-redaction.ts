/**
 * Value-aware PII redaction for every string barnacle writes out (logs,
 * telemetry NDJSON/S3, error envelopes).
 *
 * Flow instructions, log lines and error messages carry applicant values as
 * free text ("Fill in the Email field with 'x@y.com'"), so key-based
 * redaction (pino `redact`) never sees them. Instead, each dispatch registers
 * its inbound payload's values here and every sink scrubs occurrences of them.
 *
 * The registry is process-global rather than request-scoped: pooled browser
 * sessions and Stagehand callbacks log outside the request's async context,
 * and scrubbing one run's values from another concurrent run's output is a
 * harmless over-redaction.
 */

import { LRUCache } from "lru-cache";

/**
 * Inbound-payload keys that are job/attribution identifiers rather than
 * applicant data. Safe to persist verbatim and never redacted.
 */
export const NON_PII_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  "JobId",
  "jobId",
  "ClickUrl",
  "BaseUrl",
  "TrackingUrl",
  "scenario",
]);

/**
 * Keys whose values are matched case-insensitively on word boundaries:
 * sites and LLMs re-case names and addresses ("SMITH", "smith"), and these
 * are short enough that substring matching would over-trigger.
 */
const IDENTITY_KEYS: ReadonlySet<string> = new Set([
  "FirstName",
  "LastName",
  "Email",
  "AddressLine",
  "City",
  "County",
  "PostalCode",
]);

/** Keys holding phone numbers, matched in any common US formatting. */
const PHONE_KEY = /phone/i;

/** Binary/encoded résumé content: never appears as text in logs. */
const SKIPPED_KEYS: ReadonlySet<string> = new Set(["Resume", "ResumeBase64"]);

const MIN_IDENTITY_LENGTH = 2;
const MIN_OTHER_LENGTH = 4;
const DEFAULT_RELEASE_GRACE_MS = 10 * 60 * 1000;
/** Upper bound on any registration — far beyond a run's task timeout, so a run that never releases (crash) still ages out. */
const MAX_REGISTRATION_TTL_MS = 2 * 60 * 60 * 1000;
/** Far above concurrent runs + their grace windows + minted secrets; only bounds memory. */
const MAX_REGISTRY_ENTRIES = 10_000;
const MAX_DEEP_REDACT_DEPTH = 6;

interface SensitiveMatcher {
  pattern: RegExp;
  label: string;
  valueLength: number;
}

let compiled: SensitiveMatcher[] | null = null;

const registry = new LRUCache<string, SensitiveMatcher[]>({
  max: MAX_REGISTRY_ENTRIES,
  ttlAutopurge: true,
  dispose: () => {
    compiled = null;
  },
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function identityMatcher(value: string, label: string): SensitiveMatcher {
  return {
    pattern: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(value)}(?![\\p{L}\\p{N}])`, "giu"),
    label,
    valueLength: value.length,
  };
}

function phoneMatcher(value: string, label: string): SensitiveMatcher | null {
  const digits = value.replace(/\D/g, "").slice(-10);
  if (digits.length !== 10) return null;
  const [area, exchange, line] = [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6)];
  return {
    pattern: new RegExp(
      `(?<!\\d)(?:\\+?1[\\s.-]?)?\\(?${area}\\)?[\\s.-]?${exchange}[\\s.-]?${line}(?!\\d)`,
      "g"
    ),
    label,
    valueLength: value.length,
  };
}

function literalMatcher(value: string, label: string): SensitiveMatcher {
  return { pattern: new RegExp(escapeRegExp(value), "g"), label, valueLength: value.length };
}

function collectMatchers(value: unknown, topKey: string, out: SensitiveMatcher[]): void {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (PHONE_KEY.test(topKey)) {
      const matcher = phoneMatcher(trimmed, topKey);
      if (matcher) out.push(matcher);
      return;
    }
    if (IDENTITY_KEYS.has(topKey)) {
      if (trimmed.length >= MIN_IDENTITY_LENGTH) out.push(identityMatcher(trimmed, topKey));
      return;
    }
    if (trimmed.length >= MIN_OTHER_LENGTH) out.push(literalMatcher(trimmed, topKey));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectMatchers(item, topKey, out);
    return;
  }
  if (value !== null && typeof value === "object" && !Buffer.isBuffer(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      collectMatchers(nested, topKey, out);
    }
  }
}

function activeMatchers(): SensitiveMatcher[] {
  if (compiled) return compiled;
  // Longest literals first so "Mary Ann" is replaced before "Mary".
  compiled = [...registry.values()].flat().sort((a, b) => b.valueLength - a.valueLength);
  return compiled;
}

/**
 * Registers a dispatch's inbound payload so its values are scrubbed from all
 * output until {@link releaseSensitiveValues} plus a grace period — the
 * payload is the one place the engine knows which strings are applicant PII.
 */
export function registerSensitiveValues(runId: string, payload: unknown): void {
  if (payload === null || typeof payload !== "object") return;
  const matchers: SensitiveMatcher[] = [];
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (NON_PII_PAYLOAD_KEYS.has(key) || SKIPPED_KEYS.has(key)) continue;
    collectMatchers(value, key, matchers);
  }
  registry.set(runId, matchers, { ttl: MAX_REGISTRATION_TTL_MS });
  compiled = null;
}

/**
 * Schedules a run's values for removal. The grace period keeps late output
 * (teardown logs, deferred telemetry, pooled-session callbacks) scrubbed.
 */
export function releaseSensitiveValues(
  runId: string,
  graceMs: number = DEFAULT_RELEASE_GRACE_MS
): void {
  const matchers = registry.get(runId);
  if (!matchers) return;
  if (graceMs <= 0) {
    registry.delete(runId);
    return;
  }
  registry.set(runId, matchers, { ttl: graceMs });
}

/**
 * Registers a value minted inside the engine (e.g. a throwaway account
 * password) that never appears in the inbound payload but must never be
 * written out either.
 */
export function registerSecretValue(value: string, ttlMs: number = MAX_REGISTRATION_TTL_MS): void {
  if (value.length < MIN_OTHER_LENGTH) return;
  registry.set(`secret:${value}`, [literalMatcher(value, "Secret")], { ttl: ttlMs });
  compiled = null;
}

/**
 * Replaces every registered sensitive value in `text` with `<FieldName>`.
 * Cheap no-op when nothing is registered, so it is safe on every log line.
 */
export function redactPii(text: string): string {
  if (registry.size === 0 || text.length === 0) return text;
  let out = text;
  for (const { pattern, label } of activeMatchers()) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, `<${label}>`);
  }
  return out;
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Structural variant of {@link redactPii} for log/telemetry objects. Errors
 * become plain `{ type, message, stack }` objects (the shape pino's err
 * serializer emits) so their messages can be scrubbed too. Other class
 * instances (Fastify's request/reply, Buffers, URLs) are returned untouched:
 * their pino serializers read prototype getters a plain copy would drop.
 */
export function redactPiiDeep(value: unknown, depth = 0): unknown {
  if (registry.size === 0) return value;
  if (typeof value === "string") return redactPii(value);
  if (depth >= MAX_DEEP_REDACT_DEPTH || value === null || typeof value !== "object") return value;
  if (value instanceof Error) {
    return {
      type: value.name,
      message: redactPii(value.message),
      stack: value.stack ? redactPii(value.stack) : undefined,
      ...(value.cause === undefined ? {} : { cause: redactPiiDeep(value.cause, depth + 1) }),
      ...(redactPiiDeep({ ...value }, depth + 1) as Record<string, unknown>),
    };
  }
  if (Array.isArray(value)) return value.map((item) => redactPiiDeep(item, depth + 1));
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      redactPiiDeep(nested, depth + 1),
    ])
  );
}

/**
 * Reduces a typed/selected value to its shape (`Aaaa`, `99/99/9999`) for
 * diagnostics: format mismatches stay debuggable (and usable as rephrase
 * evidence) without the applicant's value — including short answers like
 * "Yes" to EEO questions that are too common to register for redaction.
 */
export function maskValueShape(text: string, maxLength = 40): string {
  return text
    .slice(0, maxLength)
    .replace(/\p{Lu}/gu, "A")
    .replace(/\p{Ll}/gu, "a")
    .replace(/\p{N}/gu, "9");
}

/** Test-only: clears the registry between cases. */
export function resetSensitiveValuesForTests(): void {
  registry.clear();
  compiled = null;
}
