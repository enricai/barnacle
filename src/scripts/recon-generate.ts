/**
 * Phase 4f: reads recon artifacts and generates a complete plugin skeleton —
 * contract.ts, flows/browser-flow.ts, index.ts, and fixtures/ — so no manual
 * coding is required between running recon and registering the plugin.
 *
 * Usage:
 *   pnpm run recon:generate -- --site-id my-site [--force]
 *
 * --force overwrites an existing src/sites/<siteId>/ directory.
 *
 * Reads from:
 *   /tmp/recon/graphql/*.json        — Capture[] from recon-browser.ts
 *   /tmp/recon/replays/*.json        — ReplayResult[] from recon-http.ts
 *   /tmp/recon/replays/rate-limit.json
 *   /tmp/recon/aux/*.json            — static fixture files
 *   src/sites/<siteId>/recon-flow.json — plain-English flow steps
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { toErrorMessage } from "@/lib/errors";
import { getScriptLogger } from "@/lib/logging";
import {
  AUX_DIR,
  CAPTURES_DIR,
  type Capture,
  type RateLimitFinding,
  REPLAYS_DIR,
  type ReplayResult,
  readJsonDir,
} from "@/scripts/recon-shared";

const logger = getScriptLogger("recon-generate");

// ── helpers ──────────────────────────────────────────────────────────────────

function toPascalCase(siteId: string): string {
  return siteId
    .split(/[-_]/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}

/**
 * Recursively infers a Zod schema expression string from a JSON value.
 * Caps recursion at 4 levels to avoid generating unwieldy output for deeply
 * nested API responses — deeper fields collapse to z.unknown().
 */
function inferZodSchema(
  value: unknown,
  depth = 0,
  indent = "",
  opts: { multipartCoerce?: boolean } = {}
): string {
  if (depth > 4) return "z.unknown()";
  if (value === null) return "z.null()";
  if (typeof value === "string") return "z.string()";
  if (typeof value === "number") return opts.multipartCoerce ? "z.coerce.number()" : "z.number()";
  if (typeof value === "boolean") {
    // multipart/form-data encodes booleans as the strings "true"/"false". The
    // contract emitter (emitContractTs) prepends a MULTIPART_BOOL constant
    // wrapping z.preprocess + z.boolean() when any field needs this coercion;
    // we just reference it here to keep each field declaration short and DRY.
    return opts.multipartCoerce ? "MULTIPART_BOOL" : "z.boolean()";
  }
  if (Array.isArray(value)) {
    const item =
      value.length > 0 ? inferZodSchema(value[0], depth + 1, indent, opts) : "z.unknown()";
    return `z.array(${item})`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "z.record(z.string(), z.unknown())";
    const inner = `${indent}  `;
    // Emit identifier-shaped keys unquoted so Biome's formatter doesn't rewrite
    // the generated file on first lint:fix.
    const fields = entries
      .map(
        ([k, v]) =>
          `${inner}${isValidJsIdentifier(k) ? k : JSON.stringify(k)}: ${inferZodSchema(v, depth + 1, inner, opts)}`
      )
      .join(",\n");
    return `z.object({\n${fields},\n${indent}})`;
  }
  return "z.unknown()";
}

function deriveMinTime(rateLimits: RateLimitFinding[]): number {
  const first = rateLimits.find((f) => f.safeRps !== null);
  return first?.safeRps ? Math.floor(1000 / first.safeRps) : 200;
}

function deriveBaseUrl(captures: Capture[]): string {
  for (const c of captures) {
    try {
      const u = new URL(c.url);
      return `${u.protocol}//${u.host}`;
    } catch {
      // try next
    }
  }
  return "https://example.com";
}

const IGNORE_REQUEST_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "accept-encoding",
  "cookie",
  ":method",
  ":path",
  ":authority",
  ":scheme",
]);

/**
 * Derives BASE_HEADERS from the request headers the browser actually sent
 * during recon, filtered to those present in every capture whose endpoint
 * replayed successfully. Always includes the standard Content-Type / Accept /
 * Origin / Referer / User-Agent baseline regardless of presence count.
 *
 * Fallback: when no replays succeeded (typical for auth-gated multi-step
 * flows where every request after `/user/create` requires a token the
 * stateless replay phase can't thread), derive headers from the meaningful
 * action POSTs instead — same `extractActionSequence` definition used by
 * the submission-flow detector. This catches load-bearing site-specific
 * headers (Workday's `X-CSRF-Token`, Greenhouse's `Job-Boards-API-Token`,
 * ClearCompany's `API-ShortName`, etc.) without the generator needing to
 * know about any particular site.
 */
function deriveRequestHeaders(
  captures: Capture[],
  replays: ReplayResult[],
  baseUrl: string
): Record<string, string> {
  const successfulUrls = new Set(
    replays
      .filter((r) => r.success)
      .map((r) => {
        try {
          const u = new URL(r.url);
          return `${u.origin}${u.pathname}`;
        } catch {
          return r.url;
        }
      })
  );

  // Prefer ACTION captures (non-GET 2xx to baseUrl host, non-telemetry) as
  // the authoritative header source. Replay-matched static-asset GETs lack
  // the API-specific headers that REST endpoints require, so falling back
  // to those produces a degenerate baseline-only header set. When action
  // captures exist (multi-step submission flows), use them. For sites
  // where the flow is a single REST call (no detectable action sequence),
  // fall back to the replay-matched captures.
  const actionCaptures = extractActionSequence(captures, baseUrl).map((a) => a.capture);
  const replayMatchedCaptures = captures.filter((c) => {
    try {
      const u = new URL(c.url);
      return successfulUrls.has(`${u.origin}${u.pathname}`);
    } catch {
      return false;
    }
  });

  const relevantCaptures = actionCaptures.length > 0 ? actionCaptures : replayMatchedCaptures;

  const counts = new Map<string, number>();
  for (const c of relevantCaptures) {
    for (const header of Object.keys(c.requestHeaders)) {
      const lower = header.toLowerCase();
      if (IGNORE_REQUEST_HEADERS.has(lower)) continue;
      counts.set(lower, (counts.get(lower) ?? 0) + 1);
    }
  }

  const baseline: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, */*",
    Origin: baseUrl,
    Referer: `${baseUrl}/`,
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  };

  // Add any request header present in all relevant captures, preserving original casing.
  for (const [lower, count] of counts) {
    if (count < relevantCaptures.length) continue;
    if (Object.keys(baseline).some((k) => k.toLowerCase() === lower)) continue;
    for (const c of relevantCaptures) {
      const original = Object.keys(c.requestHeaders).find((h) => h.toLowerCase() === lower);
      if (original) {
        baseline[original] = c.requestHeaders[original]!;
        break;
      }
    }
  }

  return baseline;
}

function isGraphQL(captures: Capture[]): boolean {
  return captures.some((c) => c.operationName !== null);
}

function firstSuccessfulReplayBody(replays: ReplayResult[]): unknown {
  return replays.find((r) => r.success)?.replayBody ?? null;
}

function firstGraphQLQuery(captures: Capture[]): string | null {
  return captures.find((c) => c.query)?.query ?? null;
}

function firstEndpointPath(captures: Capture[]): string {
  for (const c of captures) {
    try {
      const u = new URL(c.url);
      return u.pathname;
    } catch {
      // skip
    }
  }
  return "/api/search";
}

// ── multi-step "submission flow" detection ────────────────────────────────────
//
// For transactional sites (apply forms, multi-step checkout, etc.) the captures
// form an ordered sequence of POSTs that thread state values through subsequent
// requests (auth tokens, candidate IDs, application IDs). Single-endpoint
// sites (job search, pricing APIs) have one action capture and skip this path.

/** Path elements we always treat as noise (analytics, logging). */
const TELEMETRY_URL_PATTERNS = [
  "/util/logging/vweb/message",
  "/blank/page",
  "stats.g.doubleclick.net",
  "google-analytics.com",
  "click.appcast.io",
];

interface ActionCapture {
  capture: Capture;
  index: number;
}

/**
 * Extracts the ordered sequence of meaningful POSTs that represent the
 * transactional flow. Filters out GETs, telemetry, asset hits, and non-2xx.
 */
function extractActionSequence(captures: Capture[], baseUrl: string): ActionCapture[] {
  let host: string;
  try {
    host = new URL(baseUrl).host;
  } catch {
    host = "";
  }

  return captures
    .map((capture, index) => ({ capture, index }))
    .filter(({ capture }) => {
      if (capture.method === "GET") return false;
      if (capture.status < 200 || capture.status >= 300) return false;
      let captureHost: string;
      try {
        captureHost = new URL(capture.url).host;
      } catch {
        return false;
      }
      if (captureHost !== host) return false;
      if (TELEMETRY_URL_PATTERNS.some((p) => capture.url.includes(p))) return false;
      return true;
    });
}

interface StateValue {
  /** The raw string that appears in some response and is reused downstream. */
  value: string;
  /** Index of the capture whose response is the EARLIEST origin of this value. */
  originIndex: number;
  /** JSON path within the origin response (e.g. ["Auth", "Token"]). */
  path: string[];
}

/**
 * Recursively walks a JSON value and yields every string leaf, paired with its
 * JSON path. Numbers/booleans/nulls are skipped — only string leaves are
 * candidates for state values (auth tokens, UUIDs, IDs).
 */
function* walkStringLeaves(
  value: unknown,
  path: string[] = []
): Generator<{ value: string; path: string[] }, void, unknown> {
  if (typeof value === "string") {
    yield { value, path };
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      yield* walkStringLeaves(value[i], [...path, String(i)]);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      yield* walkStringLeaves(v, [...path, k]);
    }
  }
}

/**
 * Yields every primitive leaf (string, number, boolean, null) in the JSON
 * value with its path. Used by the body-literal substitution pass to find
 * JSON-keyed values whose key matches a payload field name — for example,
 * `"FutureConsideration":true` becomes `"FutureConsideration":${payload.FutureConsideration}`.
 * Unlike walkStringLeaves this includes non-string primitives, so boolean
 * and number payload fields get parameterized too.
 */
function* walkAllPrimitiveLeaves(
  value: unknown,
  path: string[] = []
): Generator<{ value: string | number | boolean | null; path: string[] }, void, unknown> {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    yield { value, path };
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      yield* walkAllPrimitiveLeaves(value[i], [...path, String(i)]);
    }
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      yield* walkAllPrimitiveLeaves(v, [...path, k]);
    }
  }
}

/** Minimum length for a string leaf to be indexed as a potential state value.
 * Shorter strings (1-7 chars) are rarely meaningful auth tokens / IDs and
 * inflate the index without contributing to state threading. */
const MIN_STATE_VALUE_LENGTH = 8;

/**
 * Documented enum of common HTTP-API error-reporting key names. Closed set
 * (per the no-regex-open-sets feedback): when an API returns 200 with an
 * error payload, it almost always uses one of these key names at the top of
 * the body. Matched case-insensitively so `Message`/`message`/`Error`/`error`
 * all detect.
 */
const KNOWN_TOP_LEVEL_ERROR_KEYS = new Set(["message", "error", "errormessage"]);

/**
 * Suffixes that mark a JSON key as carrying validation/data errors when its
 * value is non-null. Case-sensitive because real APIs use mixed-case in the
 * exact form they ship (e.g. ClearCompany's `ResponseValidationErrors`).
 */
const NESTED_ERROR_KEY_SUFFIXES = ["ValidationErrors", "DataErrors", "ValidationError"];

interface ErrorSignals {
  /** Top-level string-valued key whose presence in a response signals an
   * error. Emitted by the generator as a `typeof obj.X === "string"` guard. */
  stringMessageKey: string | null;
  /** JSON paths whose non-null value signals an error. The `parentPath` walks
   * to the parent object and `errorKey` is the leaf property name. Emitted as
   * `obj.<parentPath>.<errorKey> != null` guards. */
  nestedErrorPaths: Array<{ parentPath: string[]; errorKey: string }>;
}

/**
 * Detects which error-reporting key names this site's recon uses. Scans
 * successful action-step response bodies for the well-known key shapes; only
 * emits guards for keys that NEVER appear as non-null values in success
 * responses (so legitimate success-only fields like `Name` aren't false-
 * flagged as errors).
 *
 * Site-agnostic: ClearCompany uses `Message`/`Sections.ResponseValidationErrors`
 * /`Sections.DataValidationErrors`; a different ATS using `error`/`errors[]`
 * would emit guards for those instead.
 */
function detectErrorSignals(actions: ActionStep[]): ErrorSignals {
  const candidateTopLevelKeys = new Map<string, { presentInSuccess: boolean }>();
  const candidateNestedPaths = new Map<
    string,
    { parentPath: string[]; errorKey: string; presentInSuccess: boolean }
  >();

  for (const step of actions) {
    const body = step.capture.responseBody;
    if (body === null || typeof body !== "object" || Array.isArray(body)) continue;

    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (KNOWN_TOP_LEVEL_ERROR_KEYS.has(k.toLowerCase())) {
        const existing = candidateTopLevelKeys.get(k) ?? { presentInSuccess: false };
        if (typeof v === "string" && v.length > 0) existing.presentInSuccess = true;
        candidateTopLevelKeys.set(k, existing);
      }
    }

    walkForNestedErrorKeys(body, [], candidateNestedPaths);
  }

  const successKeys = new Set<string>();
  for (const [k, info] of candidateTopLevelKeys) {
    if (info.presentInSuccess) successKeys.add(k);
  }
  const stringMessageKey =
    [...candidateTopLevelKeys.keys()].find((k) => !successKeys.has(k)) ?? null;

  const nestedErrorPaths: ErrorSignals["nestedErrorPaths"] = [];
  for (const info of candidateNestedPaths.values()) {
    if (!info.presentInSuccess) {
      nestedErrorPaths.push({ parentPath: info.parentPath, errorKey: info.errorKey });
    }
  }

  return { stringMessageKey, nestedErrorPaths };
}

function walkForNestedErrorKeys(
  value: unknown,
  path: string[],
  candidates: Map<string, { parentPath: string[]; errorKey: string; presentInSuccess: boolean }>
): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (NESTED_ERROR_KEY_SUFFIXES.some((suffix) => k.endsWith(suffix))) {
      const dedupeKey = `${path.join(".")}::${k}`;
      const existing = candidates.get(dedupeKey) ?? {
        parentPath: path,
        errorKey: k,
        presentInSuccess: false,
      };
      if (v !== null) existing.presentInSuccess = true;
      candidates.set(dedupeKey, existing);
    }
    walkForNestedErrorKeys(v, [...path, k], candidates);
  }
}

/**
 * Map from form-schema FieldId UUIDs to PascalCase payload field names. Used
 * by emitMultiStepExecuteHttp to substitute Responses[].Value literals with
 * caller payload references. Empty when the recon doesn't include a form
 * schema (no-op for those sites).
 */
type FieldNameMap = Map<string, string>;

/**
 * Converts a FieldSourceCode like "contact.first.name" or "address.country.subdivision"
 * to PascalCase: "ContactFirstName", "AddressCountrySubdivision". Site-agnostic:
 * operates only on the input string. Returns null for inputs that don't
 * produce a valid JS identifier.
 */
function sourceCodeToPascalCase(sourceCode: string): string | null {
  const parts = sourceCode.split(/[.\-_\s]+/).filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  const pascal = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join("");
  return isValidJsIdentifier(pascal) ? pascal : null;
}

/**
 * Converts a free-form FieldName like "Reference #1 First Name" or "Email" to
 * PascalCase, stripping punctuation in a way that preserves position (so
 * "Reference #1 First Name" → "Reference1FirstName" via a section-heading
 * prefix). Site-agnostic: operates only on input strings.
 */
function fieldNameToPascalCase(fieldName: string, prefix: string | null): string | null {
  const cleaned = fieldName.replace(/[^a-zA-Z0-9\s]/g, " ").trim();
  if (cleaned === "") return null;
  const parts = cleaned.split(/\s+/).filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  const pascal = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join("");
  const withPrefix = prefix ? `${prefix}${pascal}` : pascal;
  return isValidJsIdentifier(withPrefix) ? withPrefix : null;
}

/**
 * Recon-driven detection of form-schema captures. Scans all response bodies
 * for arrays whose objects look like SectionField (UUID-shaped FieldId plus
 * FieldName or FieldSourceCode). Builds FieldId → PascalCase name map.
 *
 * Site-agnostic: identifies form-schema captures by structural fingerprint,
 * not by URL or site name. Any ATS exposing a similar schema would match.
 */
function detectFormSchemaFieldNames(captures: Capture[]): FieldNameMap {
  const fieldNameMap: FieldNameMap = new Map();
  for (const capture of captures) {
    walkForSectionFieldsArrays(capture.responseBody, fieldNameMap);
  }
  return fieldNameMap;
}

function walkForSectionFieldsArrays(value: unknown, fieldNameMap: FieldNameMap): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    if (looksLikeSectionFieldsArray(value)) {
      assignFieldNamesFromArray(value as Array<Record<string, unknown>>, fieldNameMap);
    }
    for (const item of value) walkForSectionFieldsArrays(item, fieldNameMap);
    return;
  }
  for (const v of Object.values(value as Record<string, unknown>)) {
    walkForSectionFieldsArrays(v, fieldNameMap);
  }
}

/**
 * Structural fingerprint: array of objects, at least half of which have a
 * UUID-shaped FieldId AND at least one of FieldName/FieldSourceCode.
 */
function looksLikeSectionFieldsArray(arr: unknown[]): boolean {
  if (arr.length === 0) return false;
  let matches = 0;
  for (const item of arr) {
    if (item === null || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const fieldIdRaw = obj.FieldId;
    if (typeof fieldIdRaw !== "string") continue;
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(fieldIdRaw)) {
      continue;
    }
    if (typeof obj.FieldName === "string" || typeof obj.FieldSourceCode === "string") {
      matches++;
    }
  }
  return matches >= Math.max(1, Math.floor(arr.length * 0.5));
}

function assignFieldNamesFromArray(
  arr: Array<Record<string, unknown>>,
  fieldNameMap: FieldNameMap
): void {
  let currentPrefix: string | null = null;
  const usedNames = new Set<string>([...fieldNameMap.values()]);
  for (const obj of arr) {
    const fieldId = obj.FieldId;
    if (typeof fieldId !== "string") continue;

    const sourceCode = obj.FieldSourceCode;
    const name = obj.FieldName;

    let semantic: string | null = null;
    if (typeof sourceCode === "string" && sourceCode.trim().length > 0) {
      semantic = sourceCodeToPascalCase(sourceCode);
      currentPrefix = null;
    } else if (typeof name === "string" && name.trim().length > 0 && name.length < 80) {
      const hasNoSourceCode = typeof sourceCode !== "string" || sourceCode.trim().length === 0;
      // Section-heading heuristic: short FieldName, no SourceCode, MOSTLY
      // uppercase letters (>= 70% of alphabetic chars) OR contains '#'.
      // Whole-name uppercase ratio avoids false positives like "MM/DD/YYYY"
      // appearing as a format hint inside a normal field label.
      const letters = name.replace(/[^a-zA-Z]/g, "");
      const upperLetters = name.replace(/[^A-Z]/g, "");
      const isMostlyUppercase = letters.length >= 3 && upperLetters.length / letters.length >= 0.7;
      const isSectionHeading = hasNoSourceCode && (isMostlyUppercase || name.includes("#"));
      if (isSectionHeading) {
        const headingPrefix = fieldNameToPascalCase(name, null);
        if (headingPrefix !== null) {
          currentPrefix = headingPrefix;
        }
        continue;
      }
      semantic = fieldNameToPascalCase(name, currentPrefix);
    }

    if (semantic !== null && !fieldNameMap.has(fieldId)) {
      let unique = semantic;
      let suffix = 2;
      while (usedNames.has(unique)) {
        unique = `${semantic}${suffix}`;
        suffix++;
      }
      fieldNameMap.set(fieldId, unique);
      usedNames.add(unique);
    }
  }
}

/**
 * Substitutes Responses[].Value literals with payload accessors based on the
 * field-name map from the form schema. Operates on the body string before
 * state interpolation so already-substituted state values (e.g. ${firstName})
 * are preserved.
 *
 * Closed-set substring matching: both FieldId and the literal Value come from
 * the generator's own input (recon).
 */
function applyFormSchemaSubstitutions(
  rawBody: string,
  fieldNameMap: FieldNameMap,
  outDiscoveredFields: Set<string>
): string {
  if (fieldNameMap.size === 0) return rawBody;
  let result = rawBody;
  for (const [fieldId, semanticName] of fieldNameMap) {
    const fieldIdMarker = `"FieldId":"${fieldId}"`;
    let cursor = 0;
    while (true) {
      const idx = result.indexOf(fieldIdMarker, cursor);
      if (idx === -1) break;
      const objEnd = result.indexOf("}", idx);
      if (objEnd === -1) break;
      const segment = result.slice(idx, objEnd);
      const valueMarker = `"Value":"`;
      const valueIdx = segment.indexOf(valueMarker);
      if (valueIdx === -1) {
        cursor = objEnd;
        continue;
      }
      const valueStart = idx + valueIdx + valueMarker.length;
      const valueEnd = result.indexOf(`"`, valueStart);
      if (valueEnd === -1 || valueEnd > objEnd) {
        cursor = objEnd;
        continue;
      }
      const currentValue = result.slice(valueStart, valueEnd);
      if (currentValue.includes("${")) {
        cursor = objEnd;
        continue;
      }
      const replacement = `\${payload.${semanticName}}`;
      result = result.slice(0, valueStart) + replacement + result.slice(valueEnd);
      outDiscoveredFields.add(semanticName);
      cursor = valueStart + replacement.length;
    }
  }
  return result;
}

/** Maximum length to guard against indexing massive blobs (HTML fragments,
 * embedded base64 images, etc.) that aren't candidates for state threading. */
const MAX_STATE_VALUE_LENGTH = 256;

/** Canonical "uninitialized" sentinel values that some REST APIs return as
 * placeholders before a downstream call populates the real identifier.
 * ClearCompany's `/user/create` returns these for CandidateId/ApplicationId/
 * ApplyProcessId, then `/user/start` returns the real values. Indexing the
 * placeholder would lock the generated plugin's `${candidateId}` binding to
 * the all-zero UUID — every downstream call would then 404 with "candidate
 * does not exist". Closed set, literal-string match — never expand to
 * pattern-based detection (would trip the no-regex-on-open-sets rule). */
const PLACEHOLDER_STATE_VALUES = new Set(["00000000-0000-0000-0000-000000000000"]);

/**
 * Walks every capture's response (including GETs — formHistoryId-style values
 * may originate in a state-load GET, not a POST). Indexes every string leaf
 * whose length is in [MIN, MAX], recording the EARLIEST capture index that
 * produced it. Later occurrences of the same value reuse the earliest origin.
 *
 * The index is intentionally permissive — it doesn't try to shape-match
 * "what looks like a token" because token shapes are an open set across the
 * web. Authoritative filtering happens downstream in `compileActionSteps`,
 * which only emits produces[] entries for values that ALSO appear in some
 * downstream URL/headers/body (i.e. real cross-step reuse).
 *
 * Exception: values in `PLACEHOLDER_STATE_VALUES` are skipped entirely so
 * the LATER non-placeholder occurrence at the same JSON path becomes the
 * canonical binding instead.
 */
function indexStateValues(captures: Capture[]): Map<string, StateValue> {
  const index = new Map<string, StateValue>();
  for (let i = 0; i < captures.length; i++) {
    const c = captures[i]!;
    if (c.responseBody === undefined || c.responseBody === null) continue;
    for (const { value, path } of walkStringLeaves(c.responseBody)) {
      if (value.length < MIN_STATE_VALUE_LENGTH) continue;
      if (value.length > MAX_STATE_VALUE_LENGTH) continue;
      if (PLACEHOLDER_STATE_VALUES.has(value)) continue;
      if (!index.has(value)) {
        index.set(value, { value, originIndex: i, path });
      }
    }
  }
  return index;
}

interface ActionStep {
  /** The capture this step corresponds to. */
  capture: Capture;
  /** Local variable name to assign the response to (e.g. "r101"). */
  varName: string;
  /** Camelcase state values this step's response produces, ready for destructure.
   * `path` is the JSON path inside the response (used by the emitter to build
   * a narrow per-binding assertion type so the emitted access stays `any`-free). */
  produces: Array<{ name: string; pathExpr: string; path: string[] }>;
  /** Whether the request body is multipart (body bytes not in capture). */
  isMultipart: boolean;
  /** True when the capture's host differs from the immediately-preceding action. */
  isCrossDomain: boolean;
}

/** Matches strings that are valid JavaScript identifiers (start with letter/$/_,
 * followed by letters/digits/$/_). Used by the code emitter to decide between
 * dot-access vs bracket-access and quoted vs unquoted object keys. */
function isValidJsIdentifier(s: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s);
}

/** Converts a path like ["Auth","Token"] to a JS access expression ".Auth.Token". */
function pathToAccessor(path: string[]): string {
  return path.map((p) => (isValidJsIdentifier(p) ? `.${p}` : `[${JSON.stringify(p)}]`)).join("");
}

/**
 * Builds a nested TypeScript assertion type matching a JSON path. e.g.
 *   ["Auth","Token"] -> `{ Auth: { Token: string } }`
 *   ["Sections","SectionIds","0"] -> `{ Sections: { SectionIds: { "0": string } } }`
 * The leaf is always `string` because produces[] entries are only emitted for
 * string leaves (see compileActionSteps + walkStringLeaves). Used to keep
 * emitted code free of `any` casts while still letting nested-path access
 * compile against `Record<string, unknown>`-typed response variables.
 */
function pathToAssertionType(path: string[]): string {
  if (path.length === 0) return "string";
  const segment = path[0]!;
  const key = isValidJsIdentifier(segment) ? segment : JSON.stringify(segment);
  return `{ ${key}: ${pathToAssertionType(path.slice(1))} }`;
}

/** Suggests a JS-camelCase variable name for a state value path. Falls back
 * up the path if the tail is numeric or not a valid JS identifier. */
function pathToVarName(path: string[]): string {
  for (let i = path.length - 1; i >= 0; i--) {
    const segment = path[i]!;
    if (isValidJsIdentifier(segment)) {
      return segment.charAt(0).toLowerCase() + segment.slice(1);
    }
  }
  return "value";
}

/**
 * Walks the action sequence and decorates each step with: a unique response
 * var name, the state values its response produces (used by downstream steps),
 * and a multipart flag (request body bytes not captured).
 */
function compileActionSteps(
  actions: ActionCapture[],
  stateIndex: Map<string, StateValue>
): ActionStep[] {
  const usedValues = new Set<string>();
  // Pre-scan: collect all state values referenced by ANY action's URL/headers/body
  // so we only "produce" the values that are actually consumed downstream.
  for (const { capture } of actions) {
    const haystacks: string[] = [capture.url];
    for (const v of Object.values(capture.requestHeaders)) haystacks.push(v);
    if (capture.requestPostData) haystacks.push(capture.requestPostData);
    for (const sv of stateIndex.values()) {
      if (haystacks.some((h) => h.includes(sv.value))) usedValues.add(sv.value);
    }
  }

  let lastHost: string | null = null;
  return actions.map(({ capture, index }, i) => {
    const varName = `r${i}`;
    const produces: ActionStep["produces"] = [];
    const seenNames = new Set<string>();

    if (capture.responseBody !== undefined && capture.responseBody !== null) {
      for (const { value, path } of walkStringLeaves(capture.responseBody)) {
        if (!usedValues.has(value)) continue;
        const sv = stateIndex.get(value);
        // Only PRODUCE values whose earliest origin is this very capture.
        if (!sv || sv.originIndex !== index) continue;
        let name = pathToVarName(path);
        let suffix = 1;
        while (seenNames.has(name)) {
          suffix++;
          name = `${pathToVarName(path)}${suffix}`;
        }
        seenNames.add(name);
        produces.push({ name, pathExpr: `${varName}${pathToAccessor(path)}`, path });
      }
    }

    const ct = Object.entries(capture.requestHeaders).find(
      ([k]) => k.toLowerCase() === "content-type"
    );
    const isMultipart =
      (ct?.[1] ?? "").toLowerCase().includes("multipart/") && capture.requestPostData === null;

    let currentHost: string | null = null;
    try {
      currentHost = new URL(capture.url).host;
    } catch {
      currentHost = null;
    }
    const isCrossDomain = lastHost !== null && currentHost !== null && lastHost !== currentHost;
    lastHost = currentHost;

    return { capture, varName, produces, isMultipart, isCrossDomain };
  });
}

/**
 * Replaces occurrences of state values in `template` with `${varName}`
 * interpolations. Returns a JS template-literal string fragment (no backticks).
 *
 * Algorithm: walk the producing steps' response bodies in order, harvest each
 * produced value's concrete string, and map it to the produces[].name. Then
 * scan the template for those strings and replace with ${varName}. Length-
 * descending order avoids prefix conflicts (e.g. an 8-char prefix of a
 * 36-char UUID).
 */
function interpolateStateValues(
  template: string,
  priorSteps: ActionStep[],
  payloadAccessorByValue: Map<string, string> = new Map()
): string {
  const varNameByValue = new Map<string, string>();
  for (const step of priorSteps) {
    for (const p of step.produces) {
      let cursor: unknown = step.capture.responseBody;
      for (const segment of p.path) {
        if (
          cursor !== null &&
          typeof cursor === "object" &&
          segment in (cursor as Record<string, unknown>)
        ) {
          cursor = (cursor as Record<string, unknown>)[segment];
        } else {
          cursor = null;
          break;
        }
      }
      if (typeof cursor === "string") varNameByValue.set(cursor, p.name);
    }
  }

  let result = template;

  // Pass 1: substitute state values (length-descending to avoid prefix
  // conflicts). `\$` is a literal dollar sign (NOT an interpolation);
  // `${varName}` interpolates the binding name at code-generation time so
  // the resulting string contains a template-literal placeholder like
  // `${candidateId}`.
  const sortedState = [...varNameByValue.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [value, varName] of sortedState) {
    result = result.split(value).join(`\${${varName}}`);
  }

  // Pass 2: substitute payload values that survived the state pass. Same
  // length-descending order. The payload pass only fires on remaining
  // literal occurrences, so state substitutions win on collisions
  // (e.g., when an Auth.UserName response value contains the user's email).
  const sortedPayload = [...payloadAccessorByValue.entries()].sort(
    (a, b) => b[0].length - a[0].length
  );
  for (const [value, accessor] of sortedPayload) {
    result = result.split(value).join(`\${${accessor}}`);
  }

  return result;
}

/**
 * Substitutes literal JSON key/value pairs in a body template with payload
 * interpolations. Catches short strings (e.g. Culture: "en"), booleans
 * (FutureConsideration: true), and numbers that interpolateStateValues skips
 * because they're below the state-value length threshold or non-string.
 *
 * Site-agnostic: only consults the recon's first POST body shape, doesn't
 * reference any site-specific key names.
 *
 * Substitution is **JSON-key-aware** — only fires on `"key":value` patterns
 * with the exact recon-captured value. Closed-set matching per the
 * no-regex-open-sets feedback: both the key and the value come from the
 * generator's own input. No risk of substring false positives because the
 * key-prefix anchors the match to a JSON object property.
 */
function applyPayloadKeyValueSubstitutions(template: string, inputBody: unknown): string {
  if (
    inputBody === undefined ||
    inputBody === null ||
    typeof inputBody !== "object" ||
    Array.isArray(inputBody)
  ) {
    return template;
  }
  let result = template;
  for (const { value, path } of walkAllPrimitiveLeaves(inputBody)) {
    // Only top-level fields map to caller payload fields; nested keys are
    // structural artifacts of the body shape, not caller-supplied values.
    if (path.length !== 1) continue;
    const key = path[0]!;
    if (!isValidJsIdentifier(key)) continue;
    const accessor = `payload.${key}`;
    if (typeof value === "string") {
      const target = `"${key}":${JSON.stringify(value)}`;
      const replacement = `"${key}":"\${${accessor}}"`;
      result = result.split(target).join(replacement);
    } else if (typeof value === "boolean" || typeof value === "number") {
      const target = `"${key}":${JSON.stringify(value)}`;
      const replacement = `"${key}":\${${accessor}}`;
      result = result.split(target).join(replacement);
    }
  }
  return result;
}

/** Builds the multi-step `executeHttp` body as a single template-literal string.
 *
 * Two-pass design avoids emitting unused bindings (which would trip Biome's
 * `noUnusedVariables`):
 *   1. Render URL / headers / body for each step and collect the set of
 *      `${name}` substrings actually referenced by emitted text.
 *   2. Emit. Skip per-step response bindings whose response var isn't
 *      referenced AND isn't the terminal var (needed for `return { data }`).
 *      Skip produces[] entries whose name isn't referenced anywhere downstream.
 */
/**
 * Emits per-step `throw new Error(...)` lines for each detected error signal.
 * Returns lines indented to sit inside the `if (typeof X === "object" && X !==
 * null)` wrapper that `emitMultiStepExecuteHttp` writes.
 */
function emitErrorSignalGuards(varName: string, urlPath: string, signals: ErrorSignals): string[] {
  const out: string[] = [];

  if (signals.stringMessageKey !== null) {
    const k = signals.stringMessageKey;
    out.push(
      `      if (typeof (${varName} as { ${k}?: unknown }).${k} === "string") throw new Error(\`step ${varName} (${urlPath}) returned error: \${(${varName} as { ${k}: string }).${k}}\`);`
    );
  }

  const nestedByParent = new Map<string, Array<{ errorKey: string }>>();
  for (const { parentPath, errorKey } of signals.nestedErrorPaths) {
    const key = parentPath.join(".");
    const existing = nestedByParent.get(key) ?? [];
    existing.push({ errorKey });
    nestedByParent.set(key, existing);
  }

  for (const [parentPathStr, errorKeys] of nestedByParent) {
    if (parentPathStr === "") {
      for (const { errorKey } of errorKeys) {
        out.push(
          `      if ((${varName} as { ${errorKey}?: unknown }).${errorKey} != null) throw new Error(\`step ${varName} ${errorKey.toLowerCase()}: \${JSON.stringify((${varName} as { ${errorKey}: unknown }).${errorKey})}\`);`
        );
      }
      continue;
    }
    const parentSegments = parentPathStr.split(".");
    const parentVar = `${varName}_${parentSegments[parentSegments.length - 1]!.toLowerCase()}`;
    const parentAccessor = parentSegments.join("?.");
    const parentTypeAssertion = errorKeys.map(({ errorKey }) => `${errorKey}?: unknown`).join("; ");
    const parentObjType = parentSegments
      .reverse()
      .reduce((inner, seg) => `${seg}?: { ${inner} }`, parentTypeAssertion);
    parentSegments.reverse();
    out.push(`      const ${parentVar} = (${varName} as { ${parentObjType} }).${parentAccessor};`);
    for (const { errorKey } of errorKeys) {
      const label =
        errorKey === "ResponseValidationErrors"
          ? "validation errors"
          : errorKey === "DataValidationErrors"
            ? "data errors"
            : errorKey
                .replace(/([A-Z])/g, " $1")
                .trim()
                .toLowerCase();
      out.push(
        `      if (${parentVar} != null && ${parentVar}.${errorKey} != null) throw new Error(\`step ${varName} ${label}: \${JSON.stringify(${parentVar}.${errorKey})}\`);`
      );
    }
  }

  return out;
}

function emitMultiStepExecuteHttp(
  actions: ActionStep[],
  inputBody: unknown,
  errorSignals: ErrorSignals,
  fieldNameMap: FieldNameMap,
  outDiscoveredFields: Set<string>
): string {
  interface Rendered {
    url: string;
    method: string;
    headersExpr: string;
    bodyArg: string;
  }

  // Walk the first action's request body to map each leaf string value to its
  // `payload.<accessor>` expression. The emit's second interpolation pass uses
  // this to substitute literal occurrences (e.g. "Reginald") with their
  // payload references (e.g. ${payload.FirstName}) — so the generated plugin
  // actually uses the runtime payload instead of the recon's frozen identity.
  //
  // Same MIN_STATE_VALUE_LENGTH threshold as state values: short values
  // (e.g. `"en"` for Culture, `"US"` for country) collide with arbitrary
  // substrings in URLs/bodies ("token", "entities", "Australia") and would
  // produce nonsense substitutions. Values below the threshold stay literal
  // in the emitted template — fine for short enum-like fields that rarely
  // need to vary at runtime.
  const payloadAccessorByValue = new Map<string, string>();
  if (inputBody !== undefined && inputBody !== null) {
    for (const { value, path } of walkStringLeaves(inputBody)) {
      if (value.length < MIN_STATE_VALUE_LENGTH) continue;
      payloadAccessorByValue.set(value, `payload${pathToAccessor(path)}`);
    }
  }

  // Pass 1: render every step's emitted strings; collect referenced var names.
  const rendered: Rendered[] = [];
  for (let i = 0; i < actions.length; i++) {
    const step = actions[i]!;
    const cap = step.capture;
    const prior = actions.slice(0, i);
    const url = interpolateStateValues(cap.url, prior, payloadAccessorByValue);
    // Form-schema substitution runs first on the raw recon body so its
    // FieldId-anchored matches see the original JSON. State-threading and
    // payload key-value passes then run on top.
    const rawBodyWithFormSubs = cap.requestPostData
      ? applyFormSchemaSubstitutions(cap.requestPostData, fieldNameMap, outDiscoveredFields)
      : "";
    const bodyTemplate = rawBodyWithFormSubs
      ? applyPayloadKeyValueSubstitutions(
          interpolateStateValues(rawBodyWithFormSubs, prior, payloadAccessorByValue),
          inputBody
        )
      : "";

    const perCallHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(cap.requestHeaders)) {
      const lower = k.toLowerCase();
      if (lower === "api-token" || lower === "authorization") {
        perCallHeaders[k] = interpolateStateValues(v, prior, payloadAccessorByValue);
      }
    }
    const headersExpr = Object.keys(perCallHeaders).length
      ? `headers: { ${Object.entries(perCallHeaders)
          .map(([k, v]) => `${JSON.stringify(k)}: \`${v}\``)
          .join(", ")} },`
      : "";
    const bodyArg = bodyTemplate ? `body: \`${bodyTemplate}\`,` : "";

    rendered.push({ url, method: cap.method, headersExpr, bodyArg });
  }

  // Identifier scan against the rendered text — captures `${foo}`, `${foo.bar}`,
  // etc. The first segment (anchored at `${`) is the binding's name. Closed
  // grammar (template-literal syntax we generated ourselves).
  // For multipart steps the bodyArg isn't emitted (the body is a FormData
  // built inline), but the URL and headers ARE in executable code — scan
  // only those two haystacks for multipart.
  const referencedNames = new Set<string>();
  for (let i = 0; i < rendered.length; i++) {
    const r = rendered[i]!;
    const haystacks = actions[i]!.isMultipart
      ? [r.url, r.headersExpr]
      : [r.url, r.headersExpr, r.bodyArg];
    for (const haystack of haystacks) {
      for (const match of haystack.matchAll(/\$\{([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
        referencedNames.add(match[1]!);
      }
    }
  }
  // The last step's var is also referenced by the closing `return { data }`.
  if (actions.length > 0) referencedNames.add(actions[actions.length - 1]!.varName);

  // Pass 2: emit. Skip response bindings that aren't referenced; skip
  // produces[] entries whose name isn't referenced. A step's response var
  // is still needed when at least one of its produces[] entries IS
  // referenced — the produces line dereferences it.
  const lines: string[] = [];
  const declaredNames = new Set<string>();
  for (let i = 0; i < actions.length; i++) {
    const step = actions[i]!;
    const cap = step.capture;
    const r = rendered[i]!;
    const hasReferencedProduce = step.produces.some((p) => referencedNames.has(p.name));
    const bindResponse = referencedNames.has(step.varName) || hasReferencedProduce;

    if (step.isCrossDomain) {
      lines.push(
        `    // TODO: cross-domain redirect detected (${cap.url.split("/")[2]}) — likely needs browser fallback for this step.`
      );
    }

    if (step.isMultipart) {
      // Bypasses httpClient because its typed string-body interface can't
      // carry a FormData payload. We splice in BASE_HEADERS (minus
      // Content-Type, which FormData sets to multipart/form-data with the
      // boundary it generates) so site-required custom headers like
      // API-Realm/API-AppType/etc. are carried over. The next call goes
      // back through httpClient for rate-limit + Zod parsing.
      //
      // Binary asset (file Buffer + content-type + filename) is required on
      // the payload. The plugin route is registered with @fastify/multipart's
      // `attachFieldsToBody: 'keyValues'` so callers POST these fields as
      // standard multipart/form-data — no base64-in-JSON, no fixtures.
      const fdVar = `fd_${step.varName}`;
      const respVar = `resp_${step.varName}`;
      const headersVar = `headers_${step.varName}`;
      // Extract just the per-call header overrides (API-Token etc.) from the
      // rendered headers expression to merge with BASE_HEADERS.
      const perCallHeaderEntries: string[] = [];
      for (const [k, v] of Object.entries(cap.requestHeaders)) {
        const lower = k.toLowerCase();
        if (lower === "api-token" || lower === "authorization") {
          perCallHeaderEntries.push(
            `${JSON.stringify(k)}: \`${interpolateStateValues(v, actions.slice(0, i), payloadAccessorByValue)}\``
          );
        }
      }
      const perCallHeadersLit = perCallHeaderEntries.length
        ? `, ${perCallHeaderEntries.join(", ")}`
        : "";
      // Buffer-to-Blob coercion in the emitted line below: Node's Buffer is a
      // Uint8Array subclass, but its TS type lists ArrayBufferLike (which
      // includes SharedArrayBuffer), so it isn't assignable to BlobPart
      // directly. Uint8Array.from copies the bytes into a fresh
      // ArrayBuffer-backed view that satisfies BlobPart.
      lines.push(
        `    // Expected response shape: ${JSON.stringify(summariseResponseShape(cap.responseBody))}`,
        `    const ${fdVar} = new FormData();`,
        `    const ${fdVar}_bytes = Uint8Array.from(payload.Resume);`,
        `    ${fdVar}.append("files[]", new Blob([${fdVar}_bytes], { type: payload.ResumeContentType }), payload.ResumeFilename);`,
        `    const ${headersVar} = { ...Object.fromEntries(Object.entries(BASE_HEADERS).filter(([k]) => k.toLowerCase() !== "content-type"))${perCallHeadersLit} };`,
        `    const ${respVar} = await fetch(\`${r.url}\`, {`,
        `      method: "POST",`,
        `      headers: ${headersVar},`,
        `      body: ${fdVar},`,
        `    });`,
        `    if (!${respVar}.ok) throw new Error(\`step ${step.varName} (multipart upload) failed: HTTP \${${respVar}.status}\`);`
      );
      if (bindResponse) {
        lines.push(
          `    const ${step.varName} = (await ${respVar}.json()) as Record<string, unknown>;`
        );
      } else {
        lines.push(`    await ${respVar}.json();`);
      }
    } else {
      // Always bind the response so we can emit a validation check that
      // turns 200-with-error-body responses into thrown errors instead of
      // silently chaining to downstream calls with bad state.
      lines.push(`    const ${step.varName} = (await httpClient(\`${r.url}\`, {`);
      lines.push(`      method: ${JSON.stringify(r.method)},`);
      const joined = [r.headersExpr, r.bodyArg].filter((s) => s !== "").join(" ");
      if (joined !== "") {
        lines.push(`      ${joined}`);
      }
      lines.push(`    })) as Record<string, unknown>;`);
      // Structural error-shape check — signals come from `errorSignals`,
      // which `detectErrorSignals` derived from this site's actual recon
      // (closed-set key-name detection: known top-level error keys like
      // `Message`/`error`, plus nested keys ending in `ValidationErrors`
      // etc.). Guard on `typeof obj === "object" && obj !== null` first
      // because some endpoints return `null` for an ack-without-data success.
      const urlPath = cap.url.split("/").slice(3).join("/").split("?")[0] ?? "";
      const guardLines = emitErrorSignalGuards(step.varName, urlPath, errorSignals);
      if (guardLines.length > 0) {
        lines.push(`    if (typeof ${step.varName} === "object" && ${step.varName} !== null) {`);
        for (const line of guardLines) lines.push(line);
        lines.push(`    }`);
      }
    }

    for (const p of step.produces) {
      if (declaredNames.has(p.name)) continue;
      if (!referencedNames.has(p.name)) continue;
      declaredNames.add(p.name);
      const assertion = pathToAssertionType(p.path);
      lines.push(
        `    const ${p.name} = (${step.varName} as ${assertion})${pathToAccessor(p.path)};`
      );
    }
    lines.push("");
  }

  const lastVar = actions.length > 0 ? actions[actions.length - 1]!.varName : "undefined";
  lines.push(`    return { data: ${lastVar} };`);

  return lines.join("\n");
}

function summariseResponseShape(value: unknown): unknown {
  if (value === null || typeof value !== "object") return typeof value;
  if (Array.isArray(value)) return `array(${value.length})`;
  const obj: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    obj[k] = v === null ? "null" : typeof v;
  }
  return obj;
}

// ── code emitters ─────────────────────────────────────────────────────────────

function emitContractTs(opts: {
  siteId: string;
  pascal: string;
  baseUrl: string;
  baseHeaders: Record<string, string>;
  minTime: number;
  safeRps: number;
  responseBody: unknown;
  gql: boolean;
  gqlQuery: string | null;
  endpointPath: string;
  auxFiles: string[];
  /** Multi-step submission flow body — when set, replaces the default single-endpoint hot path. */
  multiStepBody?: string;
  /** First action capture's request body — used to infer the payload schema for submission flows. */
  inputBody?: unknown;
  /** Whether the flow has a multipart upload step — derived from actionSteps at the call site. */
  hasMultipartStep?: boolean;
  /** PascalCase payload-field names discovered by walking the form schema and
   * substituting Responses[].Value literals. Added to the payload schema so
   * the caller can supply real values for them. */
  discoveredFormFields?: Set<string>;
}): string {
  const {
    siteId,
    pascal,
    baseUrl,
    baseHeaders,
    minTime,
    safeRps,
    responseBody,
    gql,
    gqlQuery,
    endpointPath,
    auxFiles,
    multiStepBody,
    inputBody,
    hasMultipartStep = false,
    discoveredFormFields,
  } = opts;

  // Multi-step plugins thread responses through many different shapes that a
  // single Zod schema can't cover — use z.unknown() so each per-step access
  // compiles cleanly. Single-endpoint plugins keep the inferred schema.
  const responseSchemaExpr = multiStepBody ? `z.unknown()` : inferZodSchema(responseBody);
  // Multi-step flows that include a multipart upload need the binary asset
  // on the payload. Add Resume/ResumeContentType/ResumeFilename as required
  // fields so the @fastify/multipart-populated request body has everything
  // the upload step needs. Site-agnostic: works for any flow with a multipart
  // step, regardless of which step in the sequence it is. The hasMultipartStep
  // flag is computed once at the call site from actionSteps.some(s.isMultipart).
  //
  // multipart/form-data wire format encodes every text field as a string, so
  // pass multipartCoerce so inferZodSchema emits MULTIPART_BOOL references for
  // booleans and z.coerce.number() for numbers at the source rather than via
  // brittle post-process string substitution. Site-agnostic: only flips on
  // when meta.multipart is true.
  const basePayloadSchemaExpr = inputBody
    ? inferZodSchema(inputBody, 0, "", { multipartCoerce: hasMultipartStep })
    : `z.object({\n  query: z.string().min(1),\n})`;
  // Form-schema-discovered fields (e.g. AddressLine1, UserSsn, Reference1FirstName)
  // are added to the payload as required strings. Site-agnostic: the set is
  // populated by applyFormSchemaSubstitutions when the recon includes a
  // detectable form schema; empty for sites without one.
  const formFieldsExtension =
    discoveredFormFields && discoveredFormFields.size > 0
      ? `.extend({\n${[...discoveredFormFields]
          .sort()
          .map((name) => `  ${name}: z.string(),`)
          .join("\n")}\n})`
      : "";
  const payloadSchemaExpr = hasMultipartStep
    ? `${basePayloadSchemaExpr}.extend({\n  Resume: z.instanceof(Buffer),\n  ResumeContentType: z.string(),\n  ResumeFilename: z.string(),\n})${formFieldsExtension}`
    : `${basePayloadSchemaExpr}${formFieldsExtension}`;
  // When the payload schema needs the MULTIPART_BOOL reference, emit its
  // declaration once at the top of the contract file so each boolean field
  // stays short (SmsOptIn: MULTIPART_BOOL,) and the preprocess expression
  // isn't duplicated per field.
  const multipartBoolDecl = hasMultipartStep
    ? `\nconst MULTIPART_BOOL = z.preprocess(\n  (v) => (v === "true" ? true : v === "false" ? false : v),\n  z.boolean(),\n);\n`
    : "";
  // Emit identifier-shaped keys unquoted so Biome's formatter doesn't rewrite
  // the generated file on first lint:fix.
  const headersLiteral = Object.entries(baseHeaders)
    .map(([k, v]) => `  ${isValidJsIdentifier(k) ? k : JSON.stringify(k)}: ${JSON.stringify(v)}`)
    .join(",\n");

  const fixtureImport =
    auxFiles.length > 0 ? `// import { loadFixture } from "@/scraper/fixtures";\n` : "";

  const clientImport = gql
    ? `import { createGraphqlClient } from "@/scraper/graphql-client";`
    : `import { createHttpClient } from "@/scraper/http-client";`;

  const queryConst =
    gql && gqlQuery
      ? `\n// Lifted verbatim from recon capture — trim UI-only fields before shipping.\nconst ${pascal.toUpperCase()}_QUERY = \`${gqlQuery.trim()}\`;\n`
      : "";

  const gqlCacheBlock = gql
    ? `
type GqlFn = (operationName: string, query: string, variables: Record<string, unknown>) => Promise<${pascal}Response>;

const gqlCache = new Map<string, GqlFn>();

function getGql(baseUrl: string): GqlFn {
  let client = gqlCache.get(baseUrl);
  if (!client) {
    client = createGraphqlClient({
      schema: ${pascal}ResponseSchema,
      bottleneck: limiter,
      baseHeaders: BASE_HEADERS,
      endpoint: \`\${baseUrl}${endpointPath}\`,
    });
    gqlCache.set(baseUrl, client);
  }
  return client;
}
`
    : `
const httpClient = createHttpClient({ schema: ${pascal}ResponseSchema, bottleneck: limiter, baseHeaders: BASE_HEADERS });
`;

  const executeHttpBody = multiStepBody
    ? multiStepBody
    : gql
      ? `    const data = await getGql(context.baseUrl)(${JSON.stringify(`${pascal}Search`)}, ${pascal.toUpperCase()}_QUERY, { q: payload.query });
    return { data };`
      : `    const data = await httpClient(\`\${context.baseUrl}${endpointPath}\`, {
      method: "POST",
      body: JSON.stringify({ query: payload.query }),
    });
    return { data };`;

  const fixtureComments =
    auxFiles.length > 0
      ? `\n// Fixtures downloaded by recon — commit to src/sites/${siteId}/fixtures/ and uncomment:\n` +
        auxFiles
          .map(
            (f) =>
              `// const ${f.replace(".json", "")} = loadFixture(${JSON.stringify(siteId)}, ${JSON.stringify(f)}, z.unknown());`
          )
          .join("\n") +
        "\n"
      : "";

  const queryChecklistLine = gql
    ? `\n *   [ ] Trim UI-only fields from ${pascal.toUpperCase()}_QUERY (keep only fields you need)`
    : "";

  return `/**
 * Generated by recon-generate.ts — review before shipping.
 *
 * Checklist:${queryChecklistLine}
 *   [ ] Narrow ${pascal}ResponseSchema to match the real response shape
 *   [ ] Adjust ${pascal}PayloadSchema to your actual request parameters
 *   [ ] Verify BASE_HEADERS — remove any that aren't load-bearing
 */

import Bottleneck from "bottleneck";
import { z } from "zod/v4";

${fixtureImport}${clientImport}
import type { BrowserSession } from "@/scraper/session";
import type { SitePlugin, SitePluginContext, SitePluginResult } from "@/site-plugin";
import { run${pascal}BrowserFlow } from "@/sites/${siteId}/flows/browser-flow";

const BASE_HEADERS: Record<string, string> = {
${headersLiteral},
};

// Safe ceiling: ${safeRps} rps — from recon rate-limit probe.
const limiter = new Bottleneck({ minTime: ${minTime} });

const ${pascal}ResponseSchema = ${responseSchemaExpr};

export type ${pascal}Response = z.infer<typeof ${pascal}ResponseSchema>;

export default ${pascal}ResponseSchema;
${multipartBoolDecl}
const ${pascal}PayloadSchema = ${payloadSchemaExpr};

export type ${pascal}Payload = z.infer<typeof ${pascal}PayloadSchema>;
${queryConst}${gqlCacheBlock}${fixtureComments}
/**
 * Plugin for ${siteId}. Tries the direct-HTTP hot path first; falls back to
 * Stagehand automatically on schema drift or bot challenge.
 */
export const ${siteId.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())}Plugin: SitePlugin<${pascal}Payload, ${pascal}Response> = {
  meta: {
    siteId: ${JSON.stringify(siteId)},
    displayName: ${JSON.stringify(pascal.replace(/([A-Z])/g, " $1").trim())},
    bodySchema: ${pascal}PayloadSchema,
    responseSchema: ${pascal}ResponseSchema,
    defaultBaseUrl: ${JSON.stringify(baseUrl)},${hasMultipartStep ? "\n    multipart: true," : ""}
  },

  /** Hot path: direct HTTP — no browser, no LLM tokens. */
  async executeHttp(
    payload: ${pascal}Payload,
    context: SitePluginContext
  ): Promise<SitePluginResult<${pascal}Response>> {
${executeHttpBody}
  },

  /** Browser fallback: Stagehand + Steel — invoked only when hot path fails. */
  async execute(
    payload: ${pascal}Payload,
    session: BrowserSession,
    context: SitePluginContext
  ): Promise<SitePluginResult<${pascal}Response>> {
    const raw = await run${pascal}BrowserFlow(session.stagehand, context.baseUrl, payload);
    return { data: raw as ${pascal}Response };
  },
};
`;
}

function emitBrowserFlowTs(opts: {
  siteId: string;
  pascal: string;
  baseUrl: string;
  flowSteps: Array<string | { step: string; optional?: boolean; upload?: boolean }>;
  isSubmissionFlow: boolean;
}): string {
  const { siteId, pascal, flowSteps, isSubmissionFlow } = opts;

  const actCalls =
    flowSteps.length > 0
      ? flowSteps
          .map((step) => {
            const instruction = typeof step === "string" ? step : step.step;
            return `  await stagehand.act(${JSON.stringify(instruction)});`;
          })
          .join("\n")
      : `  // TODO: add flow steps from src/sites/${siteId}/recon-flow.json`;

  return `/**
 * Generated by recon-generate.ts — Stagehand browser fallback for ${siteId}.
 * Core invokes this automatically when executeHttp throws HttpSchemaError or
 * HttpBotChallengeError. Update the flow steps and extract schema as needed.
 */

import type { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod/v4";

import type { ${pascal}Payload, ${pascal}Response } from "@/sites/${siteId}/contract";

const ${pascal}BrowserSchema = z.object({
  // TODO: define the fields you need — align with ${pascal}Response
  extraction: z.string(),
});

/**
 * Drives ${siteId} through the recon flow and extracts structured data.
 * Used only as fallback — the hot path in contract.ts is the production path.
 */
export async function run${pascal}BrowserFlow(
  stagehand: Stagehand,
  baseUrl: string,
  payload: ${pascal}Payload
): Promise<${pascal}Response> {
  const page = await stagehand.context.awaitActivePage();

  await page.goto(baseUrl, { waitUntil: "networkidle" });

${actCalls}

  // Uses Stagehand's default extraction schema ({ extraction: string }) — matches
  // ${pascal}BrowserSchema's shape exactly. Replace this call with the
  // 4-arg overload (extract(instruction, schema, options)) once you've
  // widened the schema, but note Stagehand v3 expects a Zod v3 schema there
  // (this codebase uses zod/v4 everywhere else).
  const result = await stagehand.extract(
    ${isSubmissionFlow ? `\`drove the ${siteId} submission flow for payload \${JSON.stringify(payload)}\`` : `\`extract results matching query: \${payload.query}\``}
  );

  return result as unknown as ${pascal}Response;
}
`;
}

function emitIndexTs(opts: { siteId: string; pascal: string }): string {
  const { siteId } = opts;
  const camel = siteId.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
  return `/**
 * Generated by recon-generate.ts.
 * Register this plugin by adding to src/plugins/loader.ts:
 *
 *   import { ${camel}Plugin } from "@/sites/${siteId}";
 *   SITE_PLUGINS.push(${camel}Plugin as SitePlugin<unknown, unknown>);
 */

export { ${camel}Plugin } from "@/sites/${siteId}/contract";
`;
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let siteId = "";
  let force = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--site-id" && args[i + 1]) siteId = args[++i]!;
    else if (args[i] === "--force") force = true;
  }

  if (!siteId) {
    logger.error("--site-id <id> is required");
    process.exit(1);
  }

  const outDir = `src/sites/${siteId}`;

  if (existsSync(outDir) && !force) {
    logger.error(`${outDir} already exists — pass --force to overwrite`);
    process.exit(1);
  }

  const captures = readJsonDir<Capture>(CAPTURES_DIR);
  const replays = readJsonDir<ReplayResult>(REPLAYS_DIR, [
    "rate-limit.json",
    "introspection-schema.json",
  ]);
  const rateLimits = (() => {
    try {
      return JSON.parse(
        readFileSync(join(REPLAYS_DIR, "rate-limit.json"), "utf8")
      ) as RateLimitFinding[];
    } catch {
      return [] as RateLimitFinding[];
    }
  })();

  const auxFiles = (() => {
    try {
      return readdirSync(AUX_DIR)
        .filter((f) => f.endsWith(".json"))
        .sort();
    } catch {
      return [] as string[];
    }
  })();

  const flowSteps = (() => {
    const flowFile = `src/sites/${siteId}/recon-flow.json`;
    try {
      return JSON.parse(readFileSync(flowFile, "utf8")) as Array<
        string | { step: string; optional?: boolean; upload?: boolean }
      >;
    } catch {
      return [] as string[];
    }
  })();

  const pascal = toPascalCase(siteId);
  const baseUrl = deriveBaseUrl(captures);
  const baseHeaders = deriveRequestHeaders(captures, replays, baseUrl);
  const minTime = deriveMinTime(rateLimits);
  const safeRps = rateLimits.find((f) => f.safeRps !== null)?.safeRps ?? Math.floor(1000 / minTime);
  const responseBody = firstSuccessfulReplayBody(replays);
  const gql = isGraphQL(captures);
  const gqlQuery = firstGraphQLQuery(captures);
  const endpointPath = firstEndpointPath(captures);

  // Detect a multi-step submission flow (transactional sites like apply forms,
  // checkout, etc.). When the action sequence has 2+ POSTs, switch the
  // contract template to emit a state-threaded executeHttp.
  const actionCaptures = gql ? [] : extractActionSequence(captures, baseUrl);
  const stateIndex =
    actionCaptures.length > 1 ? indexStateValues(captures) : new Map<string, StateValue>();
  const actionSteps =
    actionCaptures.length > 1 ? compileActionSteps(actionCaptures, stateIndex) : [];
  const isSubmissionFlow = actionSteps.length > 1;

  const inputBody = isSubmissionFlow
    ? (() => {
        try {
          return JSON.parse(actionSteps[0]!.capture.requestPostData ?? "null") as unknown;
        } catch {
          return null;
        }
      })()
    : undefined;
  const errorSignals = detectErrorSignals(actionSteps);
  const fieldNameMap = detectFormSchemaFieldNames(captures);
  const discoveredFormFields = new Set<string>();
  const multiStepBody = isSubmissionFlow
    ? emitMultiStepExecuteHttp(
        actionSteps,
        inputBody,
        errorSignals,
        fieldNameMap,
        discoveredFormFields
      )
    : undefined;
  const hasMultipartStep = actionSteps.some((s) => s.isMultipart);
  // For submission flows the final action's response body is the most useful
  // shape inference target (it's the terminal success signal). Fall back to
  // the replay body for single-endpoint sites.
  const effectiveResponseBody = isSubmissionFlow
    ? (actionSteps[actionSteps.length - 1]!.capture.responseBody ?? responseBody)
    : responseBody;

  logger.info(
    `generating plugin for ${siteId} (${gql ? "GraphQL" : isSubmissionFlow ? `submission flow, ${actionSteps.length} steps` : "single-endpoint REST"}, baseUrl: ${baseUrl})`
  );

  mkdirSync(`${outDir}/flows`, { recursive: true });

  writeFileSync(
    `${outDir}/contract.ts`,
    emitContractTs({
      siteId,
      pascal,
      baseUrl,
      baseHeaders,
      minTime,
      safeRps,
      responseBody: effectiveResponseBody,
      gql,
      gqlQuery,
      endpointPath,
      auxFiles,
      multiStepBody,
      inputBody,
      hasMultipartStep,
      discoveredFormFields,
    })
  );
  logger.info(`wrote ${outDir}/contract.ts`);

  writeFileSync(
    `${outDir}/flows/browser-flow.ts`,
    emitBrowserFlowTs({ siteId, pascal, baseUrl, flowSteps, isSubmissionFlow })
  );
  logger.info(`wrote ${outDir}/flows/browser-flow.ts`);

  writeFileSync(`${outDir}/index.ts`, emitIndexTs({ siteId, pascal }));
  logger.info(`wrote ${outDir}/index.ts`);

  if (auxFiles.length > 0) {
    mkdirSync(`${outDir}/fixtures`, { recursive: true });
    for (const f of auxFiles) {
      copyFileSync(join(AUX_DIR, f), `${outDir}/fixtures/${f}`);
    }
    logger.info(`copied ${auxFiles.length} fixture(s) to ${outDir}/fixtures/`);
  }

  logger.info(`done — review ${outDir}/, then register in src/plugins/loader.ts`);
}

main().catch((err: unknown) => {
  logger.error(`recon-generate failed: ${toErrorMessage(err)}`);
  process.exit(1);
});
