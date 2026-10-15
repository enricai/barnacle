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

import type { SensitiveVariables, TokenizedText } from "@/types/pii-redaction";

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

/** Identity keys whose values typeahead/autocomplete steps must see verbatim. */
const NEVER_TOKENIZED_KEYS: ReadonlySet<string> = new Set(["City", "County"]);

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

/**
 * Which values {@link tokenizeSensitiveValues} may swap for a Stagehand
 * `%variable%`: "anywhere" values (emails, phones, secrets, values with a
 * digit/space/@) cannot be mistaken for instruction words; "value-span"
 * values (bare names) only where the instruction supplies a value, so a nurse
 * named "Will" doesn't turn "Will you require sponsorship?" into a token.
 * City/County and free-form answers are never tokenized — typeahead and
 * select steps need the literal text to pick a matching option.
 */
type TokenScope = "anywhere" | "value-span" | "never";

interface SensitiveMatcher {
  pattern: RegExp;
  label: string;
  valueLength: number;
  tokenScope: TokenScope;
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

function identityTokenScope(value: string, label: string): TokenScope {
  if (NEVER_TOKENIZED_KEYS.has(label)) return "never";
  return label === "Email" || /[\d@\s]/.test(value) ? "anywhere" : "value-span";
}

function identityMatcher(value: string, label: string): SensitiveMatcher {
  return {
    pattern: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(value)}(?![\\p{L}\\p{N}])`, "giu"),
    label,
    valueLength: value.length,
    tokenScope: identityTokenScope(value, label),
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
    tokenScope: "anywhere",
  };
}

function literalMatcher(
  value: string,
  label: string,
  tokenScope: TokenScope = "never"
): SensitiveMatcher {
  return {
    pattern: new RegExp(escapeRegExp(value), "g"),
    label,
    valueLength: value.length,
    tokenScope,
  };
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
  registry.set(`secret:${value}`, [literalMatcher(value, "Secret", "anywhere")], { ttl: ttlMs });
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

/**
 * Value positions in an instruction: a quoted or bare value introduced by
 * with/type/enter, e.g. "fill it with 'Ann'", "Fill in Last Name with Smith".
 */
const VALUE_SPAN =
  /\b(?:with|type|enter)\s+(?:'[^']*'|"[^"]*"|[^\s'",;.][^'",;]*?(?=\s*(?:$|[,;]|\.(?:\s|$)|\s(?:in|into|if|then|and|on)\b)))/giu;

const TOKEN_REFERENCE = /%([A-Za-z][A-Za-z0-9_]*)%/g;

/** `%E2%`-style percent-encoded bytes look like tokens but are URL text. */
const PERCENT_ENCODED_BYTE = /^[0-9A-Fa-f]{2}$/;

interface TokenClaim {
  start: number;
  end: number;
  label: string;
}

function valueSpans(text: string): Array<[number, number]> {
  return [...text.matchAll(VALUE_SPAN)].map((m) => [m.index, m.index + m[0].length]);
}

/** Non-overlapping value occurrences in `text`, longest registered value first. */
function claimTokenRanges(text: string): TokenClaim[] {
  const spans = valueSpans(text);
  const claims: TokenClaim[] = [];
  for (const matcher of activeMatchers()) {
    if (matcher.tokenScope === "never") continue;
    for (const m of text.matchAll(matcher.pattern)) {
      const start = m.index;
      const end = start + m[0].length;
      const inSpan = spans.some(([s, e]) => start >= s && end <= e);
      if (matcher.tokenScope === "value-span" && !inSpan) continue;
      if (claims.some((c) => start < c.end && end > c.start)) continue;
      claims.push({ start, end, label: matcher.label });
    }
  }
  return claims.sort((a, b) => a.start - b.start);
}

/** `Email`, then `Email_2`, `Email_3`… for further distinct texts under one label. */
function nextVariableName(label: string, taken: SensitiveVariables): string {
  const base = label.replace(/[^A-Za-z0-9_]/g, "") || "Value";
  if (!(base in taken)) return base;
  const siblings = Object.keys(taken).filter((n) => n === base || n.startsWith(`${base}_`));
  return `${base}_${siblings.length + 1}`;
}

/**
 * Swaps registered applicant values (and engine-minted secrets) in a Stagehand
 * instruction for `%Name%` tokens, returning the `variables` map Stagehand
 * substitutes back only when it performs the action — so the values never
 * reach the LLM prompt, Browserbase's instruction cache or the call telemetry.
 * Each token maps to the exact text it replaced, so the typed value is
 * byte-identical to the untokenized instruction's.
 */
export function tokenizeSensitiveValues(text: string): TokenizedText {
  if (registry.size === 0 || text.length === 0) return { text, variables: {} };
  const claims = claimTokenRanges(text);
  if (claims.length === 0) return { text, variables: {} };
  const variables: SensitiveVariables = {};
  const nameByText = new Map<string, string>();
  let out = "";
  let cursor = 0;
  for (const { start, end, label } of claims) {
    const matched = text.slice(start, end);
    const name = nameByText.get(matched) ?? nextVariableName(label, variables);
    nameByText.set(matched, name);
    variables[name] = matched;
    out += `${text.slice(cursor, start)}%${name}%`;
    cursor = end;
  }
  return { text: out + text.slice(cursor), variables };
}

/** Replaces `%Name%` tokens with their values (names matched case-insensitively — LLMs re-case them). */
export function detokenize(text: string, variables: SensitiveVariables): string {
  if (Object.keys(variables).length === 0) return text;
  const byLowerName = new Map(Object.entries(variables).map(([k, v]) => [k.toLowerCase(), v]));
  return text.replace(
    TOKEN_REFERENCE,
    (m, name: string) => byLowerName.get(name.toLowerCase()) ?? m
  );
}

/**
 * Tokens left in `text` that `variables` cannot resolve — an LLM-invented
 * `%Name%` would otherwise be typed into the form verbatim.
 */
export function unresolvedTokens(text: string, variables: SensitiveVariables): string[] {
  const known = new Set(Object.keys(variables).map((k) => k.toLowerCase()));
  return [...text.matchAll(TOKEN_REFERENCE)]
    .map((m) => m[1] ?? "")
    .filter((name) => !PERCENT_ENCODED_BYTE.test(name) && !known.has(name.toLowerCase()));
}

/** Test-only: clears the registry between cases. */
export function resetSensitiveValuesForTests(): void {
  registry.clear();
  compiled = null;
}
