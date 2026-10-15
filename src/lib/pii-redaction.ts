/**
 * Value-aware redaction of request data from every string barnacle writes out
 * (logs, telemetry NDJSON/S3, error envelopes).
 *
 * Flow instructions, log lines and error messages carry request values as free
 * text ("Fill in the Email field with 'x@y.com'"), so key-based redaction (pino
 * `redact`) never sees them. Instead, each dispatch registers its request
 * body's values here and every sink scrubs occurrences of them. How each field
 * is matched comes from the plugin's {@link RedactionPolicy}; the engine itself
 * knows no field names.
 *
 * The registry is process-global rather than request-scoped: pooled browser
 * sessions and Stagehand callbacks log outside the request's async context,
 * and scrubbing one run's values from another concurrent run's output is a
 * harmless over-redaction.
 */

import { parsePhoneNumberFromString } from "libphonenumber-js/min";
import { LRUCache } from "lru-cache";

import type { RedactionPolicy, SensitiveVariables, TokenizedText } from "@/types/pii-redaction";

const MIN_WORD_LENGTH = 2;
const MIN_LITERAL_LENGTH = 4;
const MIN_DIGITS = 4;
const DEFAULT_RELEASE_GRACE_MS = 10 * 60 * 1000;
/** Upper bound on any registration — far beyond a run's task timeout, so a run that never releases (crash) still ages out. */
const MAX_REGISTRATION_TTL_MS = 2 * 60 * 60 * 1000;
/** Far above concurrent runs + their grace windows + minted secrets; only bounds memory. */
const MAX_REGISTRY_ENTRIES = 10_000;
const MAX_DEEP_REDACT_DEPTH = 6;

/**
 * Where {@link tokenizeSensitiveValues} may swap a value for a Stagehand
 * `%variable%`: "anywhere" for values that cannot be mistaken for instruction
 * words (containing a digit, `@` or whitespace, digit-matched values, minted
 * secrets); "value-span" for bare words, only where the instruction supplies a
 * value; "never" for keys the plugin did not list in `tokenizeKeys`.
 */
type TokenScope = "anywhere" | "value-span" | "never";

interface SensitiveMatcher {
  pattern: RegExp;
  label: string;
  valueLength: number;
  tokenScope: TokenScope;
}

type BaseMatcher = Omit<SensitiveMatcher, "tokenScope">;

let compiled: SensitiveMatcher[] | null = null;

const registry = new LRUCache<string, SensitiveMatcher[]>({
  max: MAX_REGISTRY_ENTRIES,
  ttlAutopurge: true,
  dispose: () => {
    compiled = null;
  },
});

const policies = new Map<string, RedactionPolicy>();

/**
 * Records a plugin's redaction policy so sinks that only see a `siteId`
 * (submission telemetry) can apply it. Called once per plugin at route
 * registration.
 */
export function registerRedactionPolicy(siteId: string, policy: RedactionPolicy | undefined): void {
  if (policy) policies.set(siteId, policy);
  else policies.delete(siteId);
}

/** The policy a plugin declared, or `undefined` (fail-closed defaults). */
export function redactionPolicyFor(siteId: string): RedactionPolicy | undefined {
  return policies.get(siteId);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wordMatcher(value: string, label: string): BaseMatcher {
  return {
    pattern: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(value)}(?![\\p{L}\\p{N}])`, "giu"),
    label,
    valueLength: value.length,
  };
}

const DIGIT_SEPARATOR = "[\\s().\\-]*";

function digitRun(digits: string): string {
  return digits.split("").join(DIGIT_SEPARATOR);
}

/**
 * Matches a value by its digits however they are formatted. An international
 * (`+…`) value also matches its national number with or without the country
 * code, and its national format (e.g. a UK trunk `0`), since country codes
 * vary in length and only a numbering-plan library can split them.
 */
function digitMatcher(value: string, label: string): BaseMatcher | null {
  const digits = value.replace(/\D/g, "");
  if (digits.length < MIN_DIGITS) return null;
  const alternatives = new Set([digitRun(digits)]);
  const phone = value.trim().startsWith("+") ? parsePhoneNumberFromString(value) : undefined;
  if (phone) {
    alternatives.add(
      `(?:\\+?${phone.countryCallingCode}${DIGIT_SEPARATOR})?(?:\\(0\\)${DIGIT_SEPARATOR})?${digitRun(phone.nationalNumber)}`
    );
    alternatives.add(digitRun(phone.formatNational().replace(/\D/g, "")));
  }
  return {
    // The optional leading "+(" is consumed so "(555) 123-4567" is replaced whole.
    pattern: new RegExp(`(?<!\\d)\\+?\\(?(?:${[...alternatives].join("|")})(?!\\d)`, "g"),
    label,
    valueLength: value.length,
  };
}

function literalMatcher(value: string, label: string): BaseMatcher {
  return { pattern: new RegExp(escapeRegExp(value), "g"), label, valueLength: value.length };
}

type MatchKind = "word" | "digit" | "literal";

function baseMatcherFor(kind: MatchKind, value: string, label: string): BaseMatcher | null {
  if (kind === "digit") return digitMatcher(value, label) ?? literalMatcher(value, label);
  if (kind === "word") return value.length >= MIN_WORD_LENGTH ? wordMatcher(value, label) : null;
  return value.length >= MIN_LITERAL_LENGTH ? literalMatcher(value, label) : null;
}

function tokenScopeFor(kind: MatchKind, value: string, tokenize: boolean): TokenScope {
  if (!tokenize) return "never";
  return kind === "digit" || /[\d@\s]/.test(value) ? "anywhere" : "value-span";
}

function matcherFor(
  kind: MatchKind,
  value: string,
  label: string,
  tokenize: boolean
): SensitiveMatcher | null {
  const base = baseMatcherFor(kind, value, label);
  return base ? { ...base, tokenScope: tokenScopeFor(kind, value, tokenize) } : null;
}

function collectMatchers(
  value: unknown,
  kind: MatchKind,
  label: string,
  tokenize: boolean,
  out: SensitiveMatcher[]
): void {
  if (typeof value === "string") {
    const matcher = matcherFor(kind, value.trim(), label, tokenize);
    if (matcher) out.push(matcher);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectMatchers(item, kind, label, tokenize, out);
    return;
  }
  if (value !== null && typeof value === "object" && !Buffer.isBuffer(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      collectMatchers(nested, kind, label, tokenize, out);
    }
  }
}

function matchKindFor(key: string, policy: RedactionPolicy | undefined): MatchKind | null {
  if (
    policy?.persistKeys?.includes(key) ||
    policy?.publicKeys?.includes(key) ||
    policy?.skipKeys?.includes(key)
  ) {
    return null;
  }
  if (policy?.digitKeys?.includes(key)) return "digit";
  if (policy?.wordKeys?.includes(key)) return "word";
  return "literal";
}

function activeMatchers(): SensitiveMatcher[] {
  if (compiled) return compiled;
  // Longest literals first so "Mary Ann" is replaced before "Mary".
  compiled = [...registry.values()].flat().sort((a, b) => b.valueLength - a.valueLength);
  return compiled;
}

/**
 * Registers a request body so its values are scrubbed from all output until
 * {@link releaseSensitiveValues} plus a grace period. The body is the one
 * place the engine sees the caller's data; the plugin's policy says how each
 * field should be matched, and unlisted fields are matched as literals.
 */
export function registerSensitiveValues(
  runId: string,
  payload: unknown,
  policy?: RedactionPolicy
): void {
  if (payload === null || typeof payload !== "object") return;
  const matchers: SensitiveMatcher[] = [];
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    const kind = matchKindFor(key, policy);
    const tokenize = policy?.tokenizeKeys?.includes(key) ?? false;
    if (kind) collectMatchers(value, kind, key, tokenize, matchers);
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
  if (value.length < MIN_LITERAL_LENGTH) return;
  registry.set(
    `secret:${value}`,
    [{ ...literalMatcher(value, "Secret"), tokenScope: "anywhere" }],
    { ttl: ttlMs }
  );
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
 * evidence) without the value itself — including short answers like "Yes"
 * that are too common to register for redaction.
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
  policies.clear();
  compiled = null;
}
