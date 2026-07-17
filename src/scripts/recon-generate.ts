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
import { PLUGIN_API_VERSION } from "@/plugins/plugin-api-version";
import { CONFIG_PLUGIN_API_VERSION, CONFIG_PLUGIN_KIND } from "@/plugins/plugin-manifest-envelope";
import { loadReconVocabulary, VOCABULARY_NONE } from "@/recon/load-vocabulary";
import { EMPTY_VOCABULARY, type ReconVocabulary } from "@/recon/vocabulary";
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

/**
 * Engine imports in GENERATED code must be package subpaths, never the `@/`
 * alias, and the reason is not visible from the source: `tsc-alias` rewrites by
 * text, so it cannot tell an import this module *uses* from one it *emits as a
 * string*. Written as `@/scraper/session`, the build silently rewrote the
 * template literal itself — shipping `dist/` emitters that generated
 * `../scraper/session` and left every out-of-tree consumer with TS2307.
 * (`@/sites/...` survived only because `src/sites/` is empty, so it resolved to
 * no file.) A bare specifier has nothing to resolve against, so the build leaves
 * it alone. `out-of-tree-e2e.test.ts` asserts this against the BUILT dist —
 * asserting it against the source would pass while the shipped artifact is broken.
 */
const ENGINE_PKG = "@enricai/barnacle";

// ── helpers ──────────────────────────────────────────────────────────────────

function toPascalCase(siteId: string): string {
  return siteId
    .split(/[-_]/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}

/**
 * The recruiting vocabulary the engine used to hardcode, kept only so consumers
 * who have not yet passed `--vocabulary` keep working through the 1.x line.
 *
 * @deprecated Pass `--vocabulary <specifier>` instead. The engine cannot know
 * what any site's forms mean, and guessing mis-fires on every non-recruiting
 * domain (a cruise site's "Select the departure port from the Country dropdown"
 * became `${payload.Country}`). Slated for deletion in 2.0.0, after which an
 * absent vocabulary on a spliceable flow is a hard error. See `src/recon/vocabulary.ts`.
 */
const DEPRECATED_BUILTIN_ATS_VOCABULARY: ReconVocabulary = {
  // Naming the subject is what separates "…select the test candidate's state"
  // (fill with the caller's data) from "…the departure port from the Country
  // dropdown" (a search facet that merely says Country).
  subject: /\b(the\s+)?(test\s+)?(candidate|applicant)'?s\b/i,
  exclusions: [
    /reference\s*#?\s*\d/i,
    /employment history/i,
    /\bcompany (name|phone)\b/i,
    /\bemployer\b/i,
    /signature/i,
    /\bfull name\b/i,
    /today'?s date/i,
    /school|institution|degree|major|education/i,
    // Screening-question shapes: "For '<question>' select '<answer>'" and any
    // step framed around a 'question'. Here the first quoted string is the
    // question label, not a candidate value — a label word inside the question
    // (e.g. "...licensed in this state?") must NOT trigger a splice that would
    // overwrite the question quote. Candidate-fill steps say "fill in the X
    // field with '...'" / "Select '...' from the X dropdown" instead.
    /^\s*for\s+'/i,
    /\bquestion\b/i,
    // A secondary phone must not fill the primary MobilePhone field.
    /\bsecondary\b[^.]*\bphone\b/i,
  ],
  table: [
    [/\bfirst name\b/i, "FirstName"],
    [/\blast name\b/i, "LastName"],
    [/\b(e-?mail|email address)\b/i, "Email"],
    [/\b(mobile phone|primary phone|phone number|mobile)\b/i, "MobilePhone"],
    [/\b(street address|address line 1)\b/i, "AddressLine1"],
    [/\bcity\b/i, "City"],
    [/\b(state|province|state\/region)\b/i, "State"],
    [/\b(zip|postal)\b/i, "PostalCode"],
    [/\bcountry\b/i, "Country"],
  ],
};

/**
 * Decide whether a flow step should splice a runtime `payload.<field>` value in
 * place of the frozen recon constant baked into its instruction. Exists so
 * generated browser-flows use the caller's real applicant identity instead of
 * recon's captured identity, while operational-default steps (decline self-ID,
 * legal yes/no answers) stay literal. Matching on the English LABEL — not the
 * drifting constant value — keeps the decision stable when recon re-captures
 * with a different identity.
 *
 * @param instruction the flow step's plain-English instruction
 * @param explicit an optional flow-authored `payloadField` override (wins outright)
 * @param forceNone when true, force a literal step (the `payloadFieldNone` opt-out)
 * @param vocabulary the consumer's domain vocabulary; defaults to the deprecated
 *   built-in recruiting table so 1.x consumers who pass nothing keep working
 * @returns the PascalCase payload field name to splice, or null to keep literal
 */
export function resolveStepPayloadField(
  instruction: string,
  explicit?: string,
  forceNone?: boolean,
  vocabulary: ReconVocabulary = DEPRECATED_BUILTIN_ATS_VOCABULARY
): string | null {
  if (forceNone) return null;
  if (explicit) return explicit;
  // A quoted literal or ${RECON_EMAIL} IS the recon constant this step would
  // replace, so it is spliceable on its own.
  const hasQuotedConstant = /'[^']*'/.test(instruction) || /\$\{RECON_EMAIL\}/.test(instruction);
  // A dropdown step carries no constant to replace, so a label match alone can't
  // tell "select the test candidate's state" (the caller's data) from "select the
  // departure port from the Country dropdown" (a facet that merely says Country).
  // Requiring the subject is what keeps this from mis-firing off-domain.
  const isDropdownStep =
    /\bdropdown\b/i.test(instruction) || /\bselect\b[^.]*\bfrom\b/i.test(instruction);
  const hasSpliceable =
    hasQuotedConstant || (isDropdownStep && vocabulary.subject.test(instruction));
  if (!hasSpliceable) return null;
  if (vocabulary.exclusions.some((rx) => rx.test(instruction))) return null;
  for (const [rx, field] of vocabulary.table) {
    if (rx.test(instruction)) return field;
  }
  return null;
}

/**
 * How deep to infer before collapsing to z.unknown(). Deep enough to reach the
 * fields that carry meaning on real inventory APIs — a cruise sailing's price
 * summary sits ~11 levels down inside products[].itineraries[].sailings[] —
 * while still bounding output for pathological payloads.
 */
const DEFAULT_MAX_INFER_DEPTH = 12;

interface InferOpts {
  multipartCoerce?: boolean;
  maxDepth?: number;
}

/**
 * Infers a Zod schema expression string from every observed sample of a value,
 * not just the first.
 *
 * Single-sample inference is wrong in ways that only surface in production: a
 * field that is null in the sample becomes z.null() and then rejects the string
 * it holds on the next page; a key absent from one array element is still
 * emitted as required; heterogeneous unions collapse to whichever shape landed
 * first. Folding over all samples lets presence counts drive .optional() and
 * observed type variety drive nullable/union, so the generated contract matches
 * what the endpoint actually returns rather than what one capture happened to
 * show.
 */
export function inferZodSchemaFromSamples(
  samples: readonly unknown[],
  depth = 0,
  indent = "",
  opts: InferOpts = {}
): string {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_INFER_DEPTH;
  if (depth > maxDepth) return "z.unknown()";

  const present = samples.filter((s) => s !== undefined);
  if (present.length === 0) return "z.unknown()";

  const nonNull = present.filter((s) => s !== null);
  const nullable = nonNull.length < present.length;
  // Every observation was null: the true type is unknowable from this data, so
  // stay permissive rather than pinning a z.null() the endpoint will violate.
  if (nonNull.length === 0) return "z.unknown()";

  const wrap = (expr: string): string => (nullable ? `${expr}.nullable()` : expr);

  const kindOf = (v: unknown): string =>
    Array.isArray(v) ? "array" : v === null ? "null" : typeof v;
  const kinds = new Set(nonNull.map(kindOf));
  // Mixed primitives (e.g. sometimes string, sometimes number) have no single
  // honest Zod expression here; z.unknown() beats a schema that rejects half
  // the real responses.
  if (kinds.size > 1) return wrap("z.unknown()");

  const kind = [...kinds][0];

  if (kind === "string") return wrap("z.string()");
  if (kind === "number") return wrap(opts.multipartCoerce ? "z.coerce.number()" : "z.number()");
  if (kind === "boolean") {
    // multipart/form-data encodes booleans as "true"/"false". The contract
    // emitter imports the shared multipartBoolean() helper from @/lib/zod-multipart
    // when any field needs this coercion; we call it here to keep field declarations short.
    return wrap(opts.multipartCoerce ? "multipartBoolean()" : "z.boolean()");
  }

  if (kind === "array") {
    // Merge across every element of every sample so optional/among-elements
    // fields are discovered instead of being decided by element [0].
    const items = (nonNull as unknown[][]).flat();
    if (items.length === 0) return wrap("z.array(z.unknown())");
    return wrap(`z.array(${inferZodSchemaFromSamples(items, depth + 1, indent, opts)})`);
  }

  if (kind === "object") {
    const objects = nonNull as Record<string, unknown>[];
    const keys = [...new Set(objects.flatMap((o) => Object.keys(o)))];
    if (keys.length === 0) return wrap("z.record(z.string(), z.unknown())");
    const inner = `${indent}  `;
    // Emit identifier-shaped keys unquoted so Biome's formatter doesn't rewrite
    // the generated file on first lint:fix.
    const fields = keys
      .map((k) => {
        const valuesForKey = objects.filter((o) => k in o).map((o) => o[k]);
        const expr = inferZodSchemaFromSamples(valuesForKey, depth + 1, inner, opts);
        // Seen on some samples but not others: the endpoint omits it sometimes,
        // so requiring it would reject valid responses.
        const optional = valuesForKey.length < objects.length ? `${expr}.optional()` : expr;
        return `${inner}${isValidJsIdentifier(k) ? k : JSON.stringify(k)}: ${optional}`;
      })
      .join(",\n");
    return wrap(`z.object({\n${fields},\n${indent}})`);
  }

  return wrap("z.unknown()");
}

/**
 * Single-sample convenience wrapper preserving the original call signature.
 */
function inferZodSchema(value: unknown, depth = 0, indent = "", opts: InferOpts = {}): string {
  return inferZodSchemaFromSamples([value], depth, indent, opts);
}

function deriveMinTime(rateLimits: RateLimitFinding[]): number {
  const first = rateLimits.find((f) => f.safeRps !== null);
  return first?.safeRps ? Math.floor(1000 / first.safeRps) : 200;
}

/**
 * Identity of the endpoint a URL addresses, ignoring query strings so the same
 * endpoint paged or filtered differently still collapses to one key. Matching
 * captures to replays depends on both sides deriving this the same way.
 */
function endpointKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

/** Empty or absent response bodies carry no evidence of an endpoint's purpose. */
function isVoidResponse(body: unknown): boolean {
  if (body === null || body === undefined || body === "") return true;
  if (typeof body !== "object") return false;
  if (Array.isArray(body)) return body.length === 0;
  return Object.keys(body).length === 0;
}

/**
 * Picks the action whose request body should define the payload schema.
 *
 * Defaults to the first action, which is right for a transactional flow: the
 * caller's data goes in with the opening POST and later steps only carry the
 * transaction forward. It is wrong when the flow's real subject is a query the
 * page issues repeatedly — a search or inventory endpoint is re-hit on every
 * filter change, while whatever happened to fire first was incidental (a
 * feature-toggle fetch, a config read). Re-issuing the same endpoint with a
 * different body is the signature of the parameters a caller would want to
 * control, so that wins. Anything less clear-cut falls through to first-action
 * behavior rather than guessing.
 *
 * A transactional flow can re-issue an endpoint too — an applicant record built
 * up across several writes — and lands on those writes for the same reason: the
 * call that merely opened the flow carries none of the caller's fields.
 */
export function selectPayloadAction<T extends { capture: Capture }>(steps: readonly T[]): T | null {
  const first = steps[0];
  if (!first) return null;

  const bodiesByEndpoint = new Map<string, Set<string>>();
  for (const step of steps) {
    const key = endpointKey(step.capture.url);
    const bodies = bodiesByEndpoint.get(key) ?? new Set<string>();
    bodies.add(step.capture.requestPostData ?? "");
    bodiesByEndpoint.set(key, bodies);
  }

  const requeried = steps.filter((step) => {
    const bodies = bodiesByEndpoint.get(endpointKey(step.capture.url));
    if (!bodies || bodies.size < 2) return false;
    // An endpoint re-hit with varying bodies but nothing to show for it is
    // chatter — client-side error reporting, beacons — not the flow's subject.
    return !isVoidResponse(step.capture.responseBody);
  });

  return requeried[0] ?? first;
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
  const successfulUrls = new Set(replays.filter((r) => r.success).map((r) => endpointKey(r.url)));

  // Prefer ACTION captures (non-GET 2xx to baseUrl host, non-telemetry) as
  // the authoritative header source. Replay-matched static-asset GETs lack
  // the API-specific headers that REST endpoints require, so falling back
  // to those produces a degenerate baseline-only header set. When action
  // captures exist (multi-step submission flows), use them. For sites
  // where the flow is a single REST call (no detectable action sequence),
  // fall back to the replay-matched captures.
  const actionCaptures = extractActionSequence(captures, baseUrl).map((a) => a.capture);
  const replayMatchedCaptures = captures.filter((c) => successfulUrls.has(endpointKey(c.url)));

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

/**
 * Path elements we always treat as noise (analytics, logging). Site-specific
 * trackers belong in RECON_TELEMETRY_URL_PATTERNS (comma-separated), not here —
 * the engine must not carry any one site's ad-tech domains.
 */
const TELEMETRY_URL_PATTERNS = [
  "/util/logging/vweb/message",
  "/blank/page",
  "stats.g.doubleclick.net",
  "google-analytics.com",
  ...(process.env.RECON_TELEMETRY_URL_PATTERNS ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean),
];

/**
 * A POST to a path whose own segment is `error`/`errors` is a client-side
 * reporting sink, never a call a caller wants replayed.
 *
 * Emitting one is worse than noise. A browser's error reports are frozen at
 * recon time, so the generated plugin re-POSTs a crash that never happened —
 * a stack trace and timestamp from the recon run, sent to the site on every
 * invocation, describing a failure in a page the plugin never loaded.
 *
 * Matched on a whole path segment rather than by substring so `/error-codes`
 * and `/terrorism-screening` stay data endpoints, and kept out of
 * TELEMETRY_URL_PATTERNS because that list is literal substrings — a site's own
 * sink is structural, not an ad-tech domain the operator must enumerate.
 */
const ERROR_SINK_PATH_SEGMENT = /(^|\/)errors?(\/|$)/i;

interface ActionCapture {
  capture: Capture;
  index: number;
}

/**
 * Extracts the ordered sequence of meaningful POSTs that represent the
 * transactional flow: same-host 2xx POSTs, minus telemetry and error-reporting
 * sinks. Assets need no filter of their own — they arrive as GETs.
 *
 * Exported for tests: this predicate decides what a generated plugin will POST
 * at a live site, and it is the only gate between a browser's incidental
 * chatter and the emitted hot path.
 */
export function extractActionSequence(captures: Capture[], baseUrl: string): ActionCapture[] {
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
      try {
        if (ERROR_SINK_PATH_SEGMENT.test(new URL(capture.url).pathname)) return false;
      } catch {
        return false;
      }
      return true;
    });
}

/**
 * Collapses redundant PATCH calls to the same endpoint path, keeping only the
 * last occurrence. SPA auto-save patterns produce one PATCH per field change,
 * but the API accepts a single full-state PATCH. Reduces the generated hot
 * path from dozens of calls to the essential sequence.
 */
function collapseRedundantPatches(actions: ActionCapture[]): ActionCapture[] {
  const lastPatchByPath = new Map<string, number>();
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i]!;
    if (a.capture.method === "PATCH") {
      const path = a.capture.url.split("?")[0] ?? a.capture.url;
      lastPatchByPath.set(path, i);
    }
  }

  return actions.filter((a, i) => {
    if (a.capture.method !== "PATCH") return true;
    const path = a.capture.url.split("?")[0] ?? a.capture.url;
    return lastPatchByPath.get(path) === i;
  });
}

interface StateValue {
  /** The raw string that appears in some response and is reused downstream. */
  value: string;
  /** Index of the capture whose response is the EARLIEST origin of this value. */
  originIndex: number;
  /** JSON path within the origin response (e.g. ["Auth", "Token"]). Empty for
   * a header/cookie-origin value — see `headerOrigin`. */
  path: string[];
  /** Set when `value` originates in a response header/cookie rather than a
   * body JSON leaf (e.g. disneycruise's `Set-Cookie: __pa=<jwt>` token mint).
   * `path` is empty in this case since there is no body accessor. */
  headerOrigin?: { sourceHeader: string; cookieName?: string };
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
 * Canonical UUID-shape test. Closed-form regex per the no-regex-open-sets
 * feedback: matches the dash-delimited 8-4-4-4-12 hex format universally used
 * by Microsoft/RFC4122 UUIDs. Used to distinguish schema identifiers (UUIDs
 * that the API uses as stable structural keys) from semantic strings.
 */
const UUID_REGEX = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/**
 * Map from form-schema FieldId UUIDs to PascalCase payload field names. Used
 * by emitMultiStepExecuteHttp to substitute Responses[].Value literals with
 * caller payload references. Empty when the recon doesn't include a form
 * schema (no-op for those sites).
 */
type FieldNameMap = Map<string, string>;

/**
 * Per-OptionId-using field: an ordered list of {semanticValue, optionId}
 * pairs derived from the form schema's FieldOptions[]. The generator emits
 * each as an OPT_<FieldName> constant + z.enum payload field; the body emit
 * pass rewrites `OptionId: "<uuid>"` slots to `OptionId: ${OPT_X[payload.X]}`.
 *
 * Only populated for fields whose options all have a non-empty Value (i.e.
 * SystemFieldOption-tagged options). Custom options without a semantic
 * label are skipped — the field's OptionIds stay baked.
 */
interface FieldOptionsMapping {
  semanticName: string;
  options: Array<{ value: string; optionId: string }>;
}
type FieldOptionsMap = Map<string, FieldOptionsMapping>;

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
/**
 * Converts an HTTP header name (e.g. `API-ShortName`, `X-CSRF-Token`) into a
 * PascalCase JS identifier suitable for a payload field name. Preserves
 * internal casing of each header-name part (so `ShortName` stays `ShortName`)
 * while normalizing UPPER-only parts (`API` → `Api`). Site-agnostic.
 */
function headerNameToPayloadFieldName(headerName: string): string {
  return headerName
    .split(/[^a-zA-Z0-9]+/)
    .filter((p) => p.length > 0)
    .map((p) => {
      const isAllUpper = p === p.toUpperCase();
      return isAllUpper
        ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()
        : p.charAt(0).toUpperCase() + p.slice(1);
    })
    .join("");
}

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
function detectFormSchemaFieldNames(captures: Capture[]): {
  fieldNameMap: FieldNameMap;
  fieldOptionsMap: FieldOptionsMap;
  allSchemaUuids: Set<string>;
} {
  const fieldNameMap: FieldNameMap = new Map();
  const fieldOptionsMap: FieldOptionsMap = new Map();
  const allSchemaUuids = new Set<string>();
  for (const capture of captures) {
    walkForSectionFieldsArrays(capture.responseBody, fieldNameMap, fieldOptionsMap);
    walkForSchemaUuids(capture.responseBody, allSchemaUuids);
  }
  return { fieldNameMap, fieldOptionsMap, allSchemaUuids };
}

/**
 * Walks a response body collecting UUID-shaped strings under a `FieldId` key, or
 * under the `Id` of an entry in a sibling `FieldOptions` array. These are stable
 * schema anchors that must be shielded from state-threading even when
 * detectFormSchemaFieldNames emits no payload-mappable name for the field (e.g.
 * when the field's FieldName is too long for our naming heuristic).
 *
 * The key names are exact by design, not an oversight: a differing wire format
 * (a lowercase `fieldId`, another vendor's option key) is the consumer's to
 * declare, not the engine's to guess — see issue #57. Matching case variants
 * here would re-broaden the very fingerprint that issue exists to narrow.
 */
function walkForSchemaUuids(value: unknown, out: Set<string>): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walkForSchemaUuids(item, out);
    return;
  }
  const obj = value as Record<string, unknown>;
  const fieldIdRaw = obj.FieldId;
  if (typeof fieldIdRaw === "string" && UUID_REGEX.test(fieldIdRaw)) {
    out.add(fieldIdRaw);
  }
  const optionsRaw = obj.FieldOptions;
  if (Array.isArray(optionsRaw)) {
    for (const opt of optionsRaw) {
      if (opt !== null && typeof opt === "object") {
        const optId = (opt as Record<string, unknown>).Id;
        if (typeof optId === "string" && UUID_REGEX.test(optId)) out.add(optId);
      }
    }
  }
  // Recurse into nested objects/arrays so nested SectionFields get walked too.
  for (const v of Object.values(obj)) walkForSchemaUuids(v, out);
}

/**
 * Closed enum of well-known cache-buster query parameter names. Stripped
 * from the schema-fetch URL template so the runtime emit doesn't carry the
 * recon's stale timestamp. Per the no-regex-open-sets feedback this is a
 * small enumerated set.
 */
const CACHE_BUSTER_QUERY_KEYS = new Set(["_", "cb", "t", "_t", "nocache"]);

function stripCacheBusterParams(url: string): string {
  try {
    const u = new URL(url);
    for (const key of CACHE_BUSTER_QUERY_KEYS) {
      u.searchParams.delete(key);
    }
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Recon-driven detection of the form-schema fetch capture. Returns the first
 * GET capture (in recon order) whose response body contains a SectionFields-
 * shaped array. Sites without such a capture get `null` and Phase B/C/D
 * become no-ops.
 *
 * Site-agnostic: identifies the fetch by structural fingerprint of the
 * response body, not by URL or site name.
 */
function detectFormSchemaFetchCapture(
  captures: Capture[],
  baseUrl: string
): { capture: Capture; index: number } | null {
  let host: string;
  try {
    host = new URL(baseUrl).host;
  } catch {
    host = "";
  }
  for (let i = 0; i < captures.length; i++) {
    const capture = captures[i]!;
    if (capture.method !== "GET") continue;
    if (capture.status < 200 || capture.status >= 300) continue;
    let captureHost: string;
    try {
      captureHost = new URL(capture.url).host;
    } catch {
      continue;
    }
    if (captureHost !== host) continue;
    if (TELEMETRY_URL_PATTERNS.some((p) => capture.url.includes(p))) continue;
    if (responseContainsSectionFields(capture.responseBody)) {
      return { capture, index: i };
    }
  }
  return null;
}

function responseContainsSectionFields(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    if (looksLikeSectionFieldsArray(value)) return true;
    for (const item of value) {
      if (responseContainsSectionFields(item)) return true;
    }
    return false;
  }
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (responseContainsSectionFields(v)) return true;
  }
  return false;
}

function walkForSectionFieldsArrays(
  value: unknown,
  fieldNameMap: FieldNameMap,
  fieldOptionsMap: FieldOptionsMap
): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    if (looksLikeSectionFieldsArray(value)) {
      assignFieldNamesFromArray(
        value as Array<Record<string, unknown>>,
        fieldNameMap,
        fieldOptionsMap
      );
    }
    for (const item of value) walkForSectionFieldsArrays(item, fieldNameMap, fieldOptionsMap);
    return;
  }
  for (const v of Object.values(value as Record<string, unknown>)) {
    walkForSectionFieldsArrays(v, fieldNameMap, fieldOptionsMap);
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
    if (!UUID_REGEX.test(fieldIdRaw)) continue;
    if (typeof obj.FieldName === "string" || typeof obj.FieldSourceCode === "string") {
      matches++;
    }
  }
  return matches >= Math.max(1, Math.floor(arr.length * 0.5));
}

function assignFieldNamesFromArray(
  arr: Array<Record<string, unknown>>,
  fieldNameMap: FieldNameMap,
  fieldOptionsMap: FieldOptionsMap
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
    } else if (typeof name === "string" && name.trim().length > 0 && name.length < 250) {
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

      // Capture FieldOptions when present and ALL options have non-empty
      // semantic Values (SystemFieldOption-tagged). Custom options with empty
      // Value are skipped — they have no semantic label, so we can't generate
      // a meaningful enum and leave the field's OptionId baked.
      const optionsRaw = obj.FieldOptions;
      if (Array.isArray(optionsRaw) && optionsRaw.length > 0) {
        const options: Array<{ value: string; optionId: string }> = [];
        let allSemantic = true;
        for (const optRaw of optionsRaw) {
          if (optRaw === null || typeof optRaw !== "object") {
            allSemantic = false;
            break;
          }
          const opt = optRaw as Record<string, unknown>;
          const optId = opt.Id;
          const optValue = opt.Value;
          if (
            typeof optId !== "string" ||
            typeof optValue !== "string" ||
            optValue.trim().length === 0
          ) {
            allSemantic = false;
            break;
          }
          options.push({ value: optValue, optionId: optId });
        }
        if (allSemantic && options.length > 0 && !fieldOptionsMap.has(fieldId)) {
          fieldOptionsMap.set(fieldId, { semanticName: unique, options });
        }
      }
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

/**
 * Substitutes Responses[].OptionId literals with payload-driven enum lookups.
 * Operates on the body string before state interpolation. For each FieldId
 * with a captured FieldOptionsMapping, find `"FieldId":"<uuid>"` and rewrite
 * the matching `"OptionId":"<uuid>"` to `"OptionId":"${OPT_<Name>[payload.<Name>]}"`.
 *
 * Order-insensitive: matches `"OptionId":"<uuid>"` anywhere within the same
 * JSON object as the FieldId (which is between this FieldId marker and the
 * closing `}`). Closed-set substring matching: both FieldId and OptionId
 * come from the generator's own input.
 */
function applyFormSchemaOptionIdSubstitutions(
  rawBody: string,
  fieldOptionsMap: FieldOptionsMap,
  outDiscoveredOptionFields: Set<string>
): string {
  if (fieldOptionsMap.size === 0) return rawBody;
  let result = rawBody;
  for (const [fieldId, mapping] of fieldOptionsMap) {
    const fieldIdMarker = `"FieldId":"${fieldId}"`;
    let cursor = 0;
    while (true) {
      const idx = result.indexOf(fieldIdMarker, cursor);
      if (idx === -1) break;
      const objEnd = result.indexOf("}", idx);
      if (objEnd === -1) break;
      const segment = result.slice(idx, objEnd);
      const optionIdMarker = `"OptionId":"`;
      const optionIdLocal = segment.indexOf(optionIdMarker);
      if (optionIdLocal === -1) {
        cursor = objEnd;
        continue;
      }
      const optionStart = idx + optionIdLocal + optionIdMarker.length;
      const optionEnd = result.indexOf(`"`, optionStart);
      if (optionEnd === -1 || optionEnd > objEnd) {
        cursor = objEnd;
        continue;
      }
      const currentOptionId = result.slice(optionStart, optionEnd);
      if (currentOptionId.includes("${")) {
        cursor = objEnd;
        continue;
      }
      const replacement = `\${OPT_${mapping.semanticName}[payload.${mapping.semanticName}]}`;
      result = result.slice(0, optionStart) + replacement + result.slice(optionEnd);
      outDiscoveredOptionFields.add(mapping.semanticName);
      cursor = optionStart + replacement.length;
    }
  }
  return result;
}

/**
 * For fields whose FieldOptions have NO semantic values (CustomFieldOption
 * options where the recon schema's `.Value` is empty), T3's OPT_* enum
 * mapping can't be emitted. Instead, parameterize the OptionId slot as a
 * caller-supplied `<FieldName>OptionId` payload field with the recon-observed
 * UUID documented in a TSDoc comment.
 *
 * Operates on the same `"FieldId":"<uuid>"` anchored search as
 * applyFormSchemaOptionIdSubstitutions, but only fires when the FieldId is
 * in fieldNameMap (has a semantic name) AND NOT in fieldOptionsMap (the
 * structured enum substitution didn't fire). Site-agnostic.
 */
function applyRawOptionIdPayloadSubstitutions(
  rawBody: string,
  fieldNameMap: FieldNameMap,
  fieldOptionsMap: FieldOptionsMap,
  outDiscoveredRawOptionFields: Map<string, string>
): string {
  if (fieldNameMap.size === 0) return rawBody;
  let result = rawBody;
  for (const [fieldId, fieldName] of fieldNameMap) {
    if (fieldOptionsMap.has(fieldId)) continue; // T3's OPT_* already handles this.
    const fieldIdMarker = `"FieldId":"${fieldId}"`;
    let cursor = 0;
    while (true) {
      const idx = result.indexOf(fieldIdMarker, cursor);
      if (idx === -1) break;
      const objEnd = result.indexOf("}", idx);
      if (objEnd === -1) break;
      const segment = result.slice(idx, objEnd);
      const optionIdMarker = `"OptionId":"`;
      const optionIdLocal = segment.indexOf(optionIdMarker);
      if (optionIdLocal === -1) {
        cursor = objEnd;
        continue;
      }
      const optionStart = idx + optionIdLocal + optionIdMarker.length;
      const optionEnd = result.indexOf(`"`, optionStart);
      if (optionEnd === -1 || optionEnd > objEnd) {
        cursor = objEnd;
        continue;
      }
      const currentOptionId = result.slice(optionStart, optionEnd);
      if (currentOptionId.includes("${")) {
        cursor = objEnd;
        continue;
      }
      const fieldNameOptionId = `${fieldName}OptionId`;
      const replacement = `\${payload.${fieldNameOptionId}}`;
      result = result.slice(0, optionStart) + replacement + result.slice(optionEnd);
      // Record the recon-observed UUID so the contract can document it in
      // a TSDoc comment as the caller's starting reference value.
      if (!outDiscoveredRawOptionFields.has(fieldNameOptionId)) {
        outDiscoveredRawOptionFields.set(fieldNameOptionId, currentOptionId);
      }
      cursor = optionStart + replacement.length;
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
 * Splits a raw `Set-Cookie` response-header string into `name`/`value` pairs.
 * Captures store `responseHeaders` as a flat `Record<string, string>`
 * (see recon-shared.ts's `Capture`), so multiple `Set-Cookie` headers from the
 * same response — if the recon browser's CDP session folds them together —
 * would already have lost their individual boundaries before reaching here;
 * this only recovers name/value pairs from whatever single string survives.
 */
function* walkSetCookiePairs(rawSetCookie: string): Generator<{ name: string; value: string }> {
  const pair = rawSetCookie.split(";", 1)[0] ?? "";
  const eq = pair.indexOf("=");
  if (eq === -1) return;
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  if (name && value) yield { name, value };
}

/**
 * Walks every capture's response (including GETs — formHistoryId-style values
 * may originate in a state-load GET, not a POST). Indexes every string leaf
 * whose length is in [MIN, MAX], recording the EARLIEST capture index that
 * produced it. Later occurrences of the same value reuse the earliest origin.
 *
 * Also indexes response-header/cookie-origin values (e.g. a `Set-Cookie`
 * auth token) the same way, tagged with `headerOrigin` instead of a body
 * `path` — this is what lets a stateful API's token-mint response feed a
 * later call's `Cookie` header via `compileActionSteps`.
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
/** Exported for unit testing — lets tests exercise the produces[] walk (body
 * AND header/cookie origins) directly against synthetic Capture sequences. */
export function indexStateValues(
  captures: Capture[],
  shieldedUuids: Set<string> = new Set(),
  actionCaptureIndices: Set<number> = new Set()
): Map<string, StateValue> {
  const index = new Map<string, StateValue>();
  // First pass: identify the earliest origin among ACTION captures for each
  // value. Action-only earliest-origin tracking is what compileActionSteps'
  // produces[] check needs — it ignores non-action captures (telemetry GETs,
  // static-asset fetches) that may have surfaced the same UUID earlier in
  // recon order. Without this, a UUID like FormId that appears in some pre-
  // r0 GET response would never produce[] from r1 because originIndex points
  // at the non-action GET that nobody emits as a step.
  const haveActionFilter = actionCaptureIndices.size > 0;
  for (let i = 0; i < captures.length; i++) {
    const c = captures[i]!;
    if (haveActionFilter && !actionCaptureIndices.has(i)) continue;
    // Headers/cookies are indexed regardless of responseBody presence — a
    // token-mint call like disneycruise's `authz/private` returns `{}` and
    // carries its whole payload in `Set-Cookie`.
    const rawSetCookie = Object.entries(c.responseHeaders).find(
      ([k]) => k.toLowerCase() === "set-cookie"
    )?.[1];
    if (rawSetCookie !== undefined) {
      for (const { name, value } of walkSetCookiePairs(rawSetCookie)) {
        if (value.length < MIN_STATE_VALUE_LENGTH) continue;
        if (value.length > MAX_STATE_VALUE_LENGTH) continue;
        if (PLACEHOLDER_STATE_VALUES.has(value)) continue;
        if (!index.has(value)) {
          index.set(value, {
            value,
            originIndex: i,
            path: [],
            headerOrigin: { sourceHeader: "set-cookie", cookieName: name },
          });
        }
      }
    }
    if (c.responseBody === undefined || c.responseBody === null) continue;
    // For GET captures, only index UUID-shaped strings. GET captures (today,
    // only the form-schema fetch inserted as an action step) surface stable
    // structural identifiers — UUIDs that downstream POSTs need to thread.
    // Short non-UUID strings ("candidate", "unlocked") from GET responses are
    // noise and create substring-collision bugs in length-descending replace:
    // e.g. "candidate" as a state value gets substituted INSIDE an already-
    // emitted ${candidateId} interpolation, producing ${${entityTypeCode}Id}.
    const isGet = c.method === "GET";
    for (const { value, path } of walkStringLeaves(c.responseBody)) {
      if (value.length < MIN_STATE_VALUE_LENGTH) continue;
      if (value.length > MAX_STATE_VALUE_LENGTH) continue;
      if (PLACEHOLDER_STATE_VALUES.has(value)) continue;
      // Schema-identifier UUIDs (FieldId, OptionId) are stable anchors that
      // T2/T3 substitution depends on remaining literal in body templates.
      // Indexing them would let state-threading rewrite the anchors and
      // corrupt T2/T3's already-substituted Values.
      if (shieldedUuids.has(value)) continue;
      if (isGet && !UUID_REGEX.test(value)) continue;
      if (!index.has(value)) {
        index.set(value, { value, originIndex: i, path });
      }
    }
  }
  return index;
}

/** A state value produced by a step's response body — read via a JSON
 * accessor on the response variable (e.g. `r6.products["0"].productId`). */
interface BodyProduce {
  kind: "body";
  name: string;
  pathExpr: string;
  path: string[];
}

/** A state value produced by a step's response header/cookie (e.g. a
 * `Set-Cookie`-minted auth token). Unlike `BodyProduce` this has no JS
 * accessor — the value never surfaces in emitted code at all, because
 * `createHttpClient`'s `bind` option (see http-client.ts) captures and
 * forwards it internally. Carried here only so the emitter knows to render
 * a `bind` entry and which request header on the CONSUMING step observed it,
 * i.e. `targetHeader`. */
interface HeaderProduce {
  kind: "header";
  name: string;
  sourceHeader: string;
  cookieName?: string;
  targetHeader: string;
}

type Produce = BodyProduce | HeaderProduce;

interface ActionStep {
  /** The capture this step corresponds to. */
  capture: Capture;
  /** Local variable name to assign the response to (e.g. "r101"). */
  varName: string;
  /** Camelcase state values this step's response produces, ready for destructure.
   * `path` is the JSON path inside the response (used by the emitter to build
   * a narrow per-binding assertion type so the emitted access stays `any`-free). */
  produces: Produce[];
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

/**
 * Converts a path like ["Auth","Token"] to a JS access expression ".Auth.Token".
 * Bracket segments (numeric array indices, non-identifier keys) get a trailing
 * `!` — under `noUncheckedIndexedAccess` an array/index-signature access types
 * as `T | undefined`, and this accessor is only ever used against a real Zod-
 * inferred array/object type (payload fields, captured response bodies), never
 * against the object-literal assertion types `pathToAssertionType` builds (those
 * use known string-literal keys, which `noUncheckedIndexedAccess` does not
 * widen). Dot segments stay bare since object property access isn't affected.
 */
function pathToAccessor(path: string[]): string {
  return path.map((p) => (isValidJsIdentifier(p) ? `.${p}` : `[${JSON.stringify(p)}]!`)).join("");
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
/** Exported for unit testing — see `indexStateValues`. */
export function compileActionSteps(
  actions: ActionCapture[],
  stateIndex: Map<string, StateValue>
): ActionStep[] {
  const usedValues = new Set<string>();
  // Maps a used state value to the request-header NAME that carries it, for
  // values whose consuming reference is a request header (not the URL/body).
  // A header-origin produce needs this as its `targetHeader` — the header the
  // *next* httpClient call must send the bound value back on. Only the first
  // consuming header name observed wins; a value used in more than one distinct
  // header downstream isn't a shape this models (see http-client.ts's `bind`,
  // which is single-target per binding).
  const usedValueTargetHeader = new Map<string, string>();
  // Pre-scan: collect all state values referenced by ANY action's URL/headers/body
  // so we only "produce" the values that are actually consumed downstream.
  for (const { capture } of actions) {
    const haystacks: string[] = [capture.url];
    if (capture.requestPostData) haystacks.push(capture.requestPostData);
    for (const sv of stateIndex.values()) {
      if (haystacks.some((h) => h.includes(sv.value))) usedValues.add(sv.value);
    }
    for (const [headerName, headerValue] of Object.entries(capture.requestHeaders)) {
      for (const sv of stateIndex.values()) {
        if (!headerValue.includes(sv.value)) continue;
        usedValues.add(sv.value);
        if (!usedValueTargetHeader.has(sv.value)) {
          usedValueTargetHeader.set(sv.value, headerName);
        }
      }
    }
  }

  let lastHost: string | null = null;
  return actions.map(({ capture, index }, i) => {
    const varName = `r${i}`;
    const produces: Produce[] = [];
    const seenNames = new Set<string>();

    // Header/cookie-origin produces — walked first so a value that appears in
    // BOTH a Set-Cookie and the JSON body (unlikely, but not ruled out) prefers
    // the header binding, which is what the runtime actually threads.
    const rawSetCookie = Object.entries(capture.responseHeaders).find(
      ([k]) => k.toLowerCase() === "set-cookie"
    )?.[1];
    if (rawSetCookie !== undefined) {
      for (const { name: cookieName, value } of walkSetCookiePairs(rawSetCookie)) {
        if (!usedValues.has(value)) continue;
        const sv = stateIndex.get(value);
        if (!sv || sv.originIndex !== index || !sv.headerOrigin) continue;
        const targetHeader = usedValueTargetHeader.get(value);
        if (!targetHeader) continue;
        let name = `${cookieName.replace(/[^A-Za-z0-9]/g, "")}Cookie`;
        if (!/^[A-Za-z_$]/.test(name)) name = `_${name}`;
        let suffix = 1;
        while (seenNames.has(name)) {
          suffix++;
          name = `${cookieName.replace(/[^A-Za-z0-9]/g, "")}Cookie${suffix}`;
        }
        seenNames.add(name);
        produces.push({
          kind: "header",
          name,
          sourceHeader: sv.headerOrigin.sourceHeader,
          cookieName: sv.headerOrigin.cookieName,
          targetHeader,
        });
      }
    }

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
        produces.push({ kind: "body", name, pathExpr: `${varName}${pathToAccessor(path)}`, path });
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
 * Collects every header/cookie-origin produce across an action sequence, in
 * step order — this is what `emitContractTs` renders as `createHttpClient`'s
 * `bind` option so the generated `executeHttp` actually forwards a value like
 * disneycruise's `Set-Cookie: __pa=<jwt>` mint to the stateful call that 401s
 * without it. Deduped by `targetHeader`: `HttpResponseBinding` (http-client.ts)
 * is one binding per target header, so if two steps somehow produced the same
 * target the earliest wins.
 */
function collectHeaderBindings(actionSteps: ActionStep[]): HeaderProduce[] {
  const byTarget = new Map<string, HeaderProduce>();
  for (const step of actionSteps) {
    for (const p of step.produces) {
      if (p.kind !== "header") continue;
      if (!byTarget.has(p.targetHeader)) byTarget.set(p.targetHeader, p);
    }
  }
  return [...byTarget.values()];
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
      // Header/cookie-origin produces have no body path — their value never
      // appears as a literal in a URL/body template (http-client's `bind`
      // forwards it directly as a request header), so there's nothing to
      // interpolate here.
      if (p.kind === "header") continue;
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
 * Site-agnostic: only consults the recon's POST body shapes, doesn't
 * reference any site-specific key names.
 *
 * Substitution is **JSON-key-aware** — only fires on `"key":value` patterns
 * with the exact recon-captured value. Closed-set matching per the
 * no-regex-open-sets feedback: both the key and the value come from the
 * generator's own input. No risk of substring false positives because the
 * key-prefix anchors the match to a JSON object property.
 *
 * additionalBodies are merged after inputBody so subsequent POST bodies' new
 * top-level keys also become caller-supplied payload fields. Used in Phase F
 * to parameterize fields like SourceCode that appear in r1's body but not
 * r0's (inputBody).
 */
function applyPayloadKeyValueSubstitutions(
  template: string,
  inputBody: unknown,
  additionalBodies: unknown[] = [],
  outAdditionalKeys: Map<string, "string" | "number" | "boolean"> = new Map()
): string {
  const merged: Array<[string, string | number | boolean | null]> = [];
  const seenKeys = new Set<string>();
  // Track keys from inputBody (r0) separately so we know which ones are NEW.
  // Only NEW keys need to be added to discovered-form-fields (the payload
  // schema's inferZodSchema(inputBody) already covers inputBody's keys).
  if (inputBody !== null && typeof inputBody === "object" && !Array.isArray(inputBody)) {
    for (const { path } of walkAllPrimitiveLeaves(inputBody)) {
      if (path.length === 1) seenKeys.add(path[0]!);
    }
  }
  const inputBodyKeys = new Set(seenKeys);
  const allBodies = [inputBody, ...additionalBodies];
  for (const body of allBodies) {
    if (body === undefined || body === null || typeof body !== "object" || Array.isArray(body)) {
      continue;
    }
    for (const { value, path } of walkAllPrimitiveLeaves(body)) {
      if (path.length !== 1) continue;
      const key = path[0]!;
      if (!isValidJsIdentifier(key)) continue;
      if (seenKeys.has(key) && body !== inputBody) continue;
      // For inputBody first pass: don't dedupe (we need all values).
      if (body === inputBody && !inputBodyKeys.has(key)) continue;
      seenKeys.add(key);
      if (value === null) continue;
      merged.push([key, value]);
      // Record only the NEW keys (not in inputBody) so the contract emitter
      // can add them to the payload schema. inputBody's keys are already
      // emitted by inferZodSchema(inputBody).
      if (!inputBodyKeys.has(key)) {
        if (typeof value === "string") outAdditionalKeys.set(key, "string");
        else if (typeof value === "number") outAdditionalKeys.set(key, "number");
        else if (typeof value === "boolean") outAdditionalKeys.set(key, "boolean");
      }
    }
  }
  let result = template;
  for (const [key, value] of merged) {
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

// ── base64 Content parameterization ──────────────────────────────────────────

/**
 * Maps a site's screening-question prompts to the payload field that answers
 * them, as `{ FieldName: [keyword, …] }`.
 *
 * Empty by default and supplied by the operator via `RECON_QUESTION_KEYWORDS`
 * (JSON) — the engine cannot know what any site asks or what a caller's payload
 * calls things. It previously hardcoded one product's field names, which capped
 * discovery at those questions and silently dropped every other site's.
 */
export function loadQuestionPromptKeywords(): Record<string, string[]> {
  const raw = process.env.RECON_QUESTION_KEYWORDS;
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, string[]>;
  } catch (err) {
    logger.warn(`RECON_QUESTION_KEYWORDS is not valid JSON, ignoring: ${toErrorMessage(err)}`);
    return {};
  }
}

const QUESTION_PROMPT_KEYWORDS: Record<string, string[]> = loadQuestionPromptKeywords();

interface QuestionAnswerMapping {
  questionId: number;
  payloadField: string;
  answers: Record<string, number>;
}

/**
 * Scans captures for a `recruitingCEQuestions` GET response and builds a
 * mapping from question prompts to payload.Answers field names using keyword
 * overlap scoring. Returns null if no questions capture is found.
 */
function buildQuestionnaireMapping(captures: Capture[]): QuestionAnswerMapping[] | null {
  const questionCapture = captures.find(
    (c) => c.method === "GET" && c.url.includes("recruitingCEQuestions")
  );
  if (!questionCapture) return null;
  const resp =
    typeof questionCapture.responseBody === "string"
      ? (JSON.parse(questionCapture.responseBody) as Record<string, unknown>)
      : (questionCapture.responseBody as Record<string, unknown> | null);
  if (!resp || !Array.isArray(resp.items)) return null;

  const mappings: QuestionAnswerMapping[] = [];
  const unmapped: string[] = [];
  for (const item of resp.items as Array<Record<string, unknown>>) {
    const prompt = String(item.Prompt ?? "").toLowerCase();
    const qid = item.AttributeName as number | undefined;
    const uiType = String(item.UIDisplayType ?? "");
    if (!qid || uiType === "TextBox") continue;

    let bestField: string | null = null;
    let bestScore = 0;
    for (const [field, keywords] of Object.entries(QUESTION_PROMPT_KEYWORDS)) {
      const score = keywords.filter((kw) => prompt.includes(kw)).length;
      if (score > bestScore) {
        bestScore = score;
        bestField = field;
      }
    }
    // A question the keyword map cannot place is the interesting case: it is a
    // question this site asks and the caller has no field for. Report it —
    // dropping it silently is how a generated plugin ends up submitting nothing
    // for a required question.
    if (!bestField || bestScore < 2) {
      unmapped.push(`${qid}: ${String(item.Prompt ?? "")}`);
      continue;
    }
    if (mappings.some((m) => m.payloadField === bestField)) continue;

    const answers: Record<string, number> = {};
    for (const a of (item.answers ?? []) as Array<Record<string, unknown>>) {
      const meaning = String(a.Meaning ?? "");
      const code = a.LookupCode as number | undefined;
      if (meaning && code) answers[meaning] = code;
    }
    mappings.push({ questionId: qid, payloadField: bestField, answers });
  }
  if (unmapped.length > 0) {
    logger.warn(
      `${unmapped.length} screening question(s) matched no payload field and will be unanswered — add keywords to RECON_QUESTION_KEYWORDS: ${unmapped.join(" | ")}`
    );
  }
  return mappings.length > 0 ? mappings : null;
}

/**
 * Builds the TypeScript source for a `buildBase64Content` function that
 * constructs the base64-encoded Content JSON from payload values and returns
 * it as a base64 string. The function replaces persona-specific values
 * with payload references and maps questionnaire answers via a static
 * lookup table derived from the recon captures.
 */
function emitBuildBase64ContentFunction(
  base64: string,
  personaValues: Map<string, string>,
  questionMapping: QuestionAnswerMapping[] | null,
  pascal: string
): string {
  const decoded = Buffer.from(base64, "base64").toString("utf8");
  const content = JSON.parse(decoded) as Record<string, unknown>;

  const candidate = (content as { candidate: Record<string, unknown> }).candidate;
  const basic = (candidate as { basicInformation: Record<string, unknown> }).basicInformation;
  const phone = basic.phone as Record<string, unknown> | undefined;
  const application = (content as { application: Record<string, unknown> }).application;
  const esig = (application as { eSignature: Record<string, unknown> }).eSignature;

  basic.firstName = "__PAYLOAD_FirstName__";
  basic.lastName = "__PAYLOAD_LastName__";
  basic.email = "__PAYLOAD_Email__";
  if (esig) esig.fullName = "__PAYLOAD_SignatureFullName__";
  if (basic.displayName && typeof basic.displayName === "string")
    basic.displayName = "__PAYLOAD_DisplayName__";
  if (phone && typeof phone.number === "string" && phone.number) phone.number = "__PAYLOAD_Phone__";

  for (const [personaVal, _payloadRef] of personaValues) {
    if (typeof basic.email === "string" && basic.email === personaVal)
      basic.email = "__PAYLOAD_Email__";
  }

  const questionnaires = (
    candidate as {
      questionnaires: Array<{
        questionnaireId: number;
        questions: Array<{
          questionId: number;
          answer: unknown;
        }>;
      }>;
    }
  ).questionnaires;
  if (questionnaires && questionMapping) {
    for (const q of questionnaires) {
      q.questionnaireId = -1;
      for (const question of q.questions) {
        const mapping = questionMapping.find((m) => m.questionId === question.questionId);
        if (mapping) {
          question.answer = `__QMAP_${mapping.payloadField}__`;
        }
      }
    }
  }

  const attachments = (candidate as { attachments: Array<{ id: string }> }).attachments;
  if (attachments) {
    for (const att of attachments) {
      if (att.id && att.id !== "draft-json-undefined") {
        att.id = "__PAYLOAD_AttachmentId__";
      }
    }
    if (attachments[0]) {
      (attachments[0] as Record<string, unknown>).appDraftId = "__PAYLOAD_DraftId__";
    }
  }

  const jsonStr = JSON.stringify(content, null, 0);

  const contentObj = JSON.parse(jsonStr) as Record<string, unknown>;

  const questionMapEntries = (questionMapping ?? []).map(
    (m) =>
      `    ${JSON.stringify(m.payloadField)}: { answers: ${JSON.stringify(m.answers)} as Record<string, number>, questionId: ${m.questionId} },`
  );

  const questionMapConst2 =
    questionMapEntries.length > 0
      ? `\nconst QUESTIONNAIRE_ANSWER_MAP = {\n${questionMapEntries.join("\n")}\n};\n`
      : "";

  const contentTemplate = JSON.stringify(contentObj, null, 2);

  const parameterized = contentTemplate
    .replace(/"__PAYLOAD_FirstName__"/g, "payload.FirstName")
    .replace(/"__PAYLOAD_LastName__"/g, "payload.LastName")
    .replace(/"__PAYLOAD_Email__"/g, "payload.Email")
    .replace(/"__PAYLOAD_Phone__"/g, "payload.Phone")
    .replace(/"__PAYLOAD_SignatureFullName__"/g, "payload.Answers.SignatureFullName")
    // biome-ignore lint/suspicious/noTemplateCurlyInString: emitted as generated template-literal source
    .replace(/"__PAYLOAD_DisplayName__"/g, "`${payload.FirstName} ${payload.LastName}`")
    .replace(/"__PAYLOAD_AttachmentId__"/g, "attachmentId")
    .replace(/"__PAYLOAD_DraftId__"/g, "draftId")
    .replace(/-1(?=,\n\s*"questions")/g, "questionnaireId");

  for (const m of questionMapping ?? []) {
    parameterized.replace(
      `"__QMAP_${m.payloadField}__"`,
      `QUESTIONNAIRE_ANSWER_MAP[${JSON.stringify(m.payloadField)}].answers[payload.Answers.${m.payloadField}] ?? "draft-json-undefined"`
    );
  }

  let finalTemplate = parameterized.replace(/"__QMAP_[^"]*__"/g, '"draft-json-undefined"');

  for (const m of questionMapping ?? []) {
    finalTemplate = finalTemplate.replace(
      `"__QMAP_${m.payloadField}__"`,
      `(QUESTIONNAIRE_ANSWER_MAP[${JSON.stringify(m.payloadField)}].answers[payload.Answers.${m.payloadField}] ?? "draft-json-undefined")`
    );
  }

  return `${questionMapConst2}
/** Builds the ATS Content payload as a base64-encoded JSON string. */
function buildBase64Content(
  payload: ${pascal}Payload,
  questionnaireId: number,
  draftId: number,
  attachmentId: string
): string {
  const content = ${finalTemplate};
  return Buffer.from(JSON.stringify(content)).toString("base64");
}
`;
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

/** Exported for unit testing — lets tests drive the multipart-upload code path directly
 * without going through the full emitContractTs pipeline. */
export function emitMultiStepExecuteHttp(
  actions: ActionStep[],
  inputBody: unknown,
  errorSignals: ErrorSignals,
  fieldNameMap: FieldNameMap,
  outDiscoveredFields: Set<string>,
  fieldOptionsMap: FieldOptionsMap,
  outDiscoveredOptionFields: Set<string>,
  outDiscoveredRawOptionFields: Map<string, string>,
  outDiscoveredAdditionalBodyKeys: Map<string, "string" | "number" | "boolean">,
  baseUrl: string,
  baseUrlDerivedHeaders: Map<string, string>,
  tenantSubdomainHeaders: Map<string, string>,
  base64PatchOverride: Map<string, string> = new Map()
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
      const accessor = `payload${pathToAccessor(path)}`;
      payloadAccessorByValue.set(value, accessor);
      // Phase F: register a lowercase variant for UUID-shaped values so case-
      // variant URL path segments (e.g. r9 echoes the requisition UUID in
      // lowercase even though r0's body had it uppercase) still get
      // substituted. Site-agnostic.
      if (UUID_REGEX.test(value) && value.toLowerCase() !== value) {
        payloadAccessorByValue.set(value.toLowerCase(), accessor);
      }
    }
  }
  // G1: register the recon's baseUrl so the existing payload-substitution pass
  // rewrites every URL occurrence to `${payload.BaseUrl}/...`. Same plugin
  // then works for any tenant on the same ATS just by passing a different
  // BaseUrl. Site-agnostic: just registers the recon's own baseUrl as a payload
  // accessor; no site-specific URL knowledge.
  if (baseUrl.length >= MIN_STATE_VALUE_LENGTH) {
    payloadAccessorByValue.set(baseUrl, "payload.BaseUrl");
    outDiscoveredFields.add("BaseUrl");
  }
  // G2: register any tenant-subdomain header values as payload-supplied fields
  // (e.g. ClearCompany's `API-ShortName: "addus"` becomes `payload.ApiShortName`).
  for (const [headerName, _value] of tenantSubdomainHeaders) {
    outDiscoveredFields.add(headerNameToPayloadFieldName(headerName));
  }

  // Phase F: gather all action POST bodies (parsed) so the T1 substitution
  // can catch top-level keys from EVERY POST, not just the first one. E.g.
  // r1's body has SourceCode/FormId/LocationIds/ReOpen — these become
  // caller-supplied payload fields (when non-null).
  const additionalBodies: unknown[] = [];
  for (let i = 1; i < actions.length; i++) {
    const cap = actions[i]!.capture;
    if (cap.method !== "POST" || !cap.requestPostData) continue;
    try {
      additionalBodies.push(JSON.parse(cap.requestPostData));
    } catch {
      // skip non-JSON bodies (e.g. multipart raw bytes)
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
    // payload key-value passes then run on top. OptionId substitution runs
    // here too: same closed-set FieldId anchor; rewrites "OptionId":"<uuid>"
    // slots to "${OPT_X[payload.X]}" lookups.
    const rawBodyWithFormSubs = cap.requestPostData
      ? applyRawOptionIdPayloadSubstitutions(
          applyFormSchemaOptionIdSubstitutions(
            applyFormSchemaSubstitutions(cap.requestPostData, fieldNameMap, outDiscoveredFields),
            fieldOptionsMap,
            outDiscoveredOptionFields
          ),
          fieldNameMap,
          fieldOptionsMap,
          outDiscoveredRawOptionFields
        )
      : "";
    let bodyTemplate = rawBodyWithFormSubs
      ? applyPayloadKeyValueSubstitutions(
          interpolateStateValues(rawBodyWithFormSubs, prior, payloadAccessorByValue),
          inputBody,
          additionalBodies,
          outDiscoveredAdditionalBodyKeys
        )
      : "";

    const contentOverride = base64PatchOverride.get(step.varName);
    if (contentOverride && bodyTemplate) {
      bodyTemplate = bodyTemplate.replace(/"Content":"ey[A-Za-z0-9+/=]{100,}"/, contentOverride);
    }

    const perCallHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(cap.requestHeaders)) {
      const lower = k.toLowerCase();
      if (lower === "api-token" || lower === "authorization") {
        perCallHeaders[k] = interpolateStateValues(v, prior, payloadAccessorByValue);
      }
    }
    // G1: emit baseUrl-derived headers (Origin, Referer) per-call from
    // payload.BaseUrl. interpolateStateValues already substituted the literal
    // baseUrl with `${payload.BaseUrl}`, so a simple sub of the recon's
    // observed baseUrl in each header value gives us `${payload.BaseUrl}/`.
    // Emit "${payload.BaseUrl}" as a template-literal placeholder into the
    // generated plugin code. Built via concatenation so Biome doesn't mistake
    // it for a placeholder in THIS file's source.
    const baseUrlPlaceholder = `$${"{"}payload.BaseUrl${"}"}`;
    for (const [headerName, observedValue] of baseUrlDerivedHeaders) {
      perCallHeaders[headerName] = observedValue.split(baseUrl).join(baseUrlPlaceholder);
    }
    // G2: emit tenant-subdomain headers per-call from caller payload field
    // (e.g. API-ShortName → ${payload.ApiShortName}). The discoveredFields
    // population above ensures the field is in the payload schema.
    for (const [headerName, _observedValue] of tenantSubdomainHeaders) {
      const fieldName = headerNameToPayloadFieldName(headerName);
      perCallHeaders[headerName] = `\${payload.${fieldName}}`;
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
  // Base64 Content overrides reference variables inside function calls
  // (e.g. buildBase64Content(payload, questionnaireId, ...)) that the
  // ${name} regex above doesn't capture. Add them explicitly.
  for (const [key, override] of base64PatchOverride.entries()) {
    if (key === "__EXTRA_VARS__") continue;
    for (const m of override.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g)) {
      const name = m[1]!;
      if (/^r\d+$/.test(name)) continue;
      referencedNames.add(name);
    }
  }

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

    if (base64PatchOverride.has(step.varName) && base64PatchOverride.has("__EXTRA_VARS__")) {
      lines.push(base64PatchOverride.get("__EXTRA_VARS__")!);
      lines.push("");
    }

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
      // G1+G2: include tenant-derived headers in the multipart fetch too.
      // Build the placeholder via concatenation so Biome doesn't mistake it
      // for a template-literal in THIS file's source.
      const baseUrlPlaceholder = `$${"{"}payload.BaseUrl${"}"}`;
      for (const [headerName, observedValue] of baseUrlDerivedHeaders) {
        const v = observedValue.split(baseUrl).join(baseUrlPlaceholder);
        perCallHeaderEntries.push(`${JSON.stringify(headerName)}: \`${v}\``);
      }
      for (const [headerName, _observedValue] of tenantSubdomainHeaders) {
        const fieldName = headerNameToPayloadFieldName(headerName);
        perCallHeaderEntries.push(`${JSON.stringify(headerName)}: \`\${payload.${fieldName}}\``);
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
        `    const ${headersVar} = { ...omitHeaderCaseInsensitive(BASE_HEADERS, "Content-Type")${perCallHeadersLit} };`,
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
      const urlPath = cap.url.split("/").slice(3).join("/").split("?")[0] ?? "";
      const guardLines = emitErrorSignalGuards(step.varName, urlPath, errorSignals);
      const needsBinding = bindResponse || guardLines.length > 0;
      if (needsBinding) {
        lines.push(`    const ${step.varName} = (await httpClient(\`${r.url}\`, {`);
      } else {
        lines.push(`    await httpClient(\`${r.url}\`, {`);
      }
      lines.push(`      method: ${JSON.stringify(r.method)},`);
      const joined = [r.headersExpr, r.bodyArg].filter((s) => s !== "").join(" ");
      if (joined !== "") {
        lines.push(`      ${joined}`);
      }
      if (needsBinding) {
        lines.push(`    })) as Record<string, unknown>;`);
      } else {
        lines.push(`    });`);
      }
      if (guardLines.length > 0) {
        lines.push(`    if (typeof ${step.varName} === "object" && ${step.varName} !== null) {`);
        for (const line of guardLines) lines.push(line);
        lines.push(`    }`);
      }
    }

    for (const p of step.produces) {
      // Header/cookie-origin produces never surface as a JS accessor —
      // createHttpClient's `bind` option (rendered once, above the steps)
      // captures and forwards the value internally.
      if (p.kind === "header") continue;
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

/**
 * Renders `headerBindings` as a trailing `, bind: [...]` fragment for
 * `createHttpClient`'s options object literal — empty string when there are
 * none, so a plugin with no header/cookie-origin state keeps the exact output
 * this emitter already produced. Structurally matches `HttpResponseBinding`
 * (http-client.ts) without importing the type: the object literal typechecks
 * against `HttpClientOptions.bind` on its own shape.
 */
function bindOptionLiteral(headerBindings: HeaderProduce[]): string {
  if (headerBindings.length === 0) return "";
  const entries = headerBindings
    .map((b) => {
      const cookieNameField =
        b.cookieName !== undefined ? ` cookieName: ${JSON.stringify(b.cookieName)},` : "";
      return `{ sourceHeader: ${JSON.stringify(b.sourceHeader)},${cookieNameField} targetHeader: ${JSON.stringify(b.targetHeader)} }`;
    })
    .join(", ");
  return `, bind: [${entries}]`;
}

// ── code emitters ─────────────────────────────────────────────────────────────

/** Generates a complete contract.ts source string for a plugin — exported so
 * unit tests can drive the emitter directly without spawning the CLI. */
export function emitContractTs(opts: {
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
  /** Full FieldOptions map (FieldId → semanticName + options). Only the
   * entries whose semanticName is in `discoveredOptionFields` will get emitted
   * — those are the fields where applyFormSchemaOptionIdSubstitutions actually
   * rewrote an OptionId slot. */
  fieldOptionsMap?: FieldOptionsMap;
  /** Semantic names whose OptionId slots were rewritten by the generator —
   * each gets an OPT_<Name> constant and a z.enum payload field. */
  discoveredOptionFields?: Set<string>;
  /** Map of FieldName-derived raw-option payload field name (e.g.
   * `WereYouReferredOptionId`) → recon-observed OptionId UUID. Each becomes
   * a `<name>: z.string()` payload field with the recon-observed UUID
   * documented in a TSDoc comment. Used for FieldOptions with empty Values
   * where T3's structured enum can't be emitted. */
  discoveredRawOptionFields?: Map<string, string>;
  /** Phase F: top-level keys observed in action POST bodies beyond r0
   * (inputBody). Mapped to their value type. Each becomes a payload field
   * (string → z.string(), number → z.number(), boolean → z.boolean()). */
  discoveredAdditionalBodyKeys?: Map<string, "string" | "number" | "boolean">;
  /** PascalCase candidate-PII field names the browser flow splices as
   * `payload.<field>` (from resolveStepPayloadField). Each is added to the
   * payload schema so those references typecheck. Shares the accumulator with
   * emitBrowserFlowTs so schema and flow can never drift. */
  payloadFieldNames?: Set<string>;
  base64ContentHelper?: string;
  /** Response-header/cookie-origin state bindings collected from the action
   * sequence's produces[] (see `collectHeaderBindings`) — rendered as
   * `createHttpClient`'s `bind` option so a value like a `Set-Cookie`-minted
   * auth token actually reaches the stateful call that needs it. */
  headerBindings?: HeaderProduce[];
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
    fieldOptionsMap,
    discoveredOptionFields,
    discoveredRawOptionFields,
    discoveredAdditionalBodyKeys,
    payloadFieldNames,
    base64ContentHelper = "",
    headerBindings = [],
  } = opts;

  // Multi-step plugins thread responses through many different shapes that a
  // single Zod schema can't cover — use z.unknown() so each per-step access
  // compiles cleanly. Single-endpoint plugins keep the inferred schema.
  //
  // This is deliberate, not an unfinished schema: a submission flow's terminal
  // shape is the plugin's OWN contract with its caller (e.g. { verified: boolean }),
  // a field that appears in zero captured responses. Inferring a schema from the
  // captures would emit the wrong shape with false confidence. z.unknown() plus
  // the generated `[ ] Narrow ResponseSchema` checklist item is the intended
  // hand-off to the plugin author, who alone knows that contract.
  const responseSchemaExpr = multiStepBody ? `z.unknown()` : inferZodSchema(responseBody);
  // Multi-step flows that include a multipart upload need the binary asset
  // on the payload. Add Resume/ResumeContentType/ResumeFilename as required
  // fields so the @fastify/multipart-populated request body has everything
  // the upload step needs. Site-agnostic: works for any flow with a multipart
  // step, regardless of which step in the sequence it is. The hasMultipartStep
  // flag is computed once at the call site from actionSteps.some(s.isMultipart).
  //
  // multipart/form-data wire format encodes every text field as a string, so
  // pass multipartCoerce so inferZodSchema emits multipartBoolean() calls for
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

  // Candidate-PII fields the browser flow splices as `payload.<field>`. Emitted
  // as required strings (z.email() for Email per the repo's z.string().email()→
  // z.email() migration) so those references typecheck in the generated flow.
  // Skip any field the form-schema pass already added to avoid a duplicate
  // `.extend` key.
  const splicedFieldNames = payloadFieldNames
    ? [...payloadFieldNames].filter((name) => !discoveredFormFields?.has(name)).sort()
    : [];
  const splicedFieldsExtension =
    splicedFieldNames.length > 0
      ? `.extend({\n${splicedFieldNames
          .map((name) => `  ${name}: ${name === "Email" ? "z.email()" : "z.string()"},`)
          .join("\n")}\n})`
      : "";

  // Build per-field OPT_<Name> constant declarations + payload-schema enum
  // entries from the form schema's FieldOptions. Only fields whose OptionId
  // slots were actually rewritten in the body (i.e. that appear in
  // discoveredOptionFields) get emitted; the rest leave their schema entries
  // unused. Computed BEFORE payloadSchemaExpr so the extension string is
  // available for the final schema concat.
  const emittedOptionMappings: FieldOptionsMapping[] = [];
  if (fieldOptionsMap && discoveredOptionFields && discoveredOptionFields.size > 0) {
    for (const mapping of fieldOptionsMap.values()) {
      if (discoveredOptionFields.has(mapping.semanticName)) {
        emittedOptionMappings.push(mapping);
      }
    }
    emittedOptionMappings.sort((a, b) => a.semanticName.localeCompare(b.semanticName));
  }
  const optionDecls = emittedOptionMappings
    .map((mapping) => {
      const entries = mapping.options
        .map(
          ({ value, optionId }) =>
            `  ${isValidJsIdentifier(value) ? value : JSON.stringify(value)}: ${JSON.stringify(optionId)},`
        )
        .join("\n");
      return `\nconst OPT_${mapping.semanticName} = {\n${entries}\n} as const;\n`;
    })
    .join("");
  const optionSchemaExtension =
    emittedOptionMappings.length > 0
      ? `.extend({\n${emittedOptionMappings
          .map(
            (m) =>
              `  ${m.semanticName}: z.enum([${m.options.map((o) => JSON.stringify(o.value)).join(", ")}]),`
          )
          .join("\n")}\n})`
      : "";

  // Phase E raw-option payload fields: FieldOptions whose .Value strings are
  // empty in the schema (CustomFieldOption) — no semantic enum is possible,
  // so the caller supplies the OptionId UUID directly. The recon-observed
  // UUID is documented in a TSDoc comment so callers have a starting point.
  const sortedRawOptionEntries = discoveredRawOptionFields
    ? [...discoveredRawOptionFields.entries()].sort(([a], [b]) => a.localeCompare(b))
    : [];
  const rawOptionSchemaExtension =
    sortedRawOptionEntries.length > 0
      ? `.extend({\n${sortedRawOptionEntries
          .map(
            ([name, reconUuid]) =>
              `  /** Recon-observed: ${reconUuid}. Caller supplies the OptionId UUID for this field. */\n  ${name}: z.string(),`
          )
          .join("\n")}\n})`
      : "";

  // Phase F: additional-body keys (from action POSTs beyond r0). Each gets a
  // payload field of the appropriate Zod type. Site-agnostic.
  const sortedAdditionalKeys = discoveredAdditionalBodyKeys
    ? [...discoveredAdditionalBodyKeys.entries()].sort(([a], [b]) => a.localeCompare(b))
    : [];
  const additionalBodyKeysExtension =
    sortedAdditionalKeys.length > 0
      ? `.extend({\n${sortedAdditionalKeys
          .map(([name, kind]) => {
            // Use multipartBoolean() for booleans when multipart is in play, so
            // multipart string-encoded "true"/"false" round-trip to native
            // booleans (matches the inputBody boolean handling for parity).
            const zod =
              kind === "string"
                ? "z.string()"
                : kind === "number"
                  ? hasMultipartStep
                    ? "z.coerce.number()"
                    : "z.number()"
                  : hasMultipartStep
                    ? "multipartBoolean()"
                    : "z.boolean()";
            return `  ${name}: ${zod},`;
          })
          .join("\n")}\n})`
      : "";

  // optionSchemaExtension is appended LAST so option enums show up at the
  // end of the payload type — the section ordering (base, multipart fields,
  // form-schema fields, option enums, raw-option fields) mirrors the body
  // emit order and keeps the generated payload type readable.
  const answersExtension = base64ContentHelper ? ".extend({ Answers: AnswersSchema })" : "";
  const payloadSchemaExpr = hasMultipartStep
    ? `${basePayloadSchemaExpr}.extend({\n  Resume: z.instanceof(Buffer),\n  ResumeContentType: z.string(),\n  ResumeFilename: z.string(),\n})${formFieldsExtension}${splicedFieldsExtension}${optionSchemaExtension}${rawOptionSchemaExtension}${additionalBodyKeysExtension}${answersExtension}`
    : `${basePayloadSchemaExpr}${formFieldsExtension}${splicedFieldsExtension}${optionSchemaExtension}${rawOptionSchemaExtension}${additionalBodyKeysExtension}${answersExtension}`;
  // When the payload schema uses multipartBoolean(), import the shared helper
  // so the generated file resolves the reference and doesn't re-inline the
  // preprocess expression per boolean field.
  const multipartBoolImport = hasMultipartStep
    ? `import { multipartBoolean } from "${ENGINE_PKG}/lib/zod-multipart";\n`
    : "";
  // Content-Type must be absent from multipart fetch calls so FormData can inject the boundary.
  const caseInsensitiveHeadersImport = hasMultipartStep
    ? `import { omitHeaderCaseInsensitive } from "${ENGINE_PKG}/lib/case-insensitive-headers";\n`
    : "";
  // Emit identifier-shaped keys unquoted so Biome's formatter doesn't rewrite
  // the generated file on first lint:fix.
  const headersLiteral = Object.entries(baseHeaders)
    .map(([k, v]) => `  ${isValidJsIdentifier(k) ? k : JSON.stringify(k)}: ${JSON.stringify(v)}`)
    .join(",\n");

  const fixtureImport =
    auxFiles.length > 0 ? `// import { loadFixture } from "${ENGINE_PKG}/scraper/fixtures";\n` : "";

  const clientImport = gql
    ? `import { createGraphqlClient } from "${ENGINE_PKG}/scraper/graphql-client";`
    : `import { createHttpClient } from "${ENGINE_PKG}/scraper/http-client";`;

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
const httpClient = createHttpClient({ schema: ${pascal}ResponseSchema, bottleneck: limiter, baseHeaders: BASE_HEADERS${bindOptionLiteral(headerBindings)} });
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

  const camel = siteId.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

  return `/**
 * Generated by recon-generate.ts — review before shipping.
 *
 * Checklist:${queryChecklistLine}
 *   [ ] Narrow ${pascal}ResponseSchema to match the real response shape
 *   [ ] Adjust ${pascal}PayloadSchema to your actual request parameters
 *   [ ] Verify BASE_HEADERS — remove any that aren't load-bearing
 *   [ ] Out-of-tree: \`pnpm add bottleneck zod\` — this file imports both
 *       directly, and a strict node_modules layout (pnpm) won't resolve
 *       them as transitive deps of @enricai/barnacle alone
 */

import Bottleneck from "bottleneck";
import { z } from "zod/v4";

${fixtureImport}${caseInsensitiveHeadersImport}${multipartBoolImport}${clientImport}
import type { BrowserSession } from "${ENGINE_PKG}/scraper/session";
import type { SitePlugin, SitePluginContext, SitePluginResult } from "${ENGINE_PKG}/site-plugin";
import { run${pascal}BrowserFlow } from "@/sites/${siteId}/flows/browser-flow";

const BASE_HEADERS: Record<string, string> = {
${headersLiteral},
};

// Safe ceiling: ${safeRps} rps — from recon rate-limit probe.
const limiter = new Bottleneck({ minTime: ${minTime} });

const ${pascal}ResponseSchema = ${responseSchemaExpr};

export type ${pascal}Response = z.infer<typeof ${pascal}ResponseSchema>;

export default ${pascal}ResponseSchema;
${optionDecls}${base64ContentHelper}
const ${pascal}PayloadSchema = ${payloadSchemaExpr};

export type ${pascal}Payload = z.infer<typeof ${pascal}PayloadSchema>;
${queryConst}${gqlCacheBlock}${fixtureComments}
/**
 * Plugin for ${siteId}. Tries the direct-HTTP hot path first; falls back to
 * Stagehand automatically on schema drift or bot challenge.
 */
export const ${camel}Plugin: SitePlugin<${pascal}Payload, ${pascal}Response> = {
  meta: {
    siteId: ${JSON.stringify(siteId)},
    displayName: ${JSON.stringify(pascal.replace(/([A-Z])/g, " $1").trim())},
    bodySchema: ${pascal}PayloadSchema,
    responseSchema: ${pascal}ResponseSchema,
    defaultBaseUrl: ${JSON.stringify(baseUrl)},
    apiVersion: ${JSON.stringify(PLUGIN_API_VERSION)},${hasMultipartStep ? "\n    multipart: true," : ""}
  },

  /** Hot path: direct HTTP — no browser, no LLM tokens. */
  async executeHttp(
    payload: ${pascal}Payload,
    ${executeHttpBody.includes("context.") ? "context" : "_context"}: SitePluginContext
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

// Out-of-tree loader resolves \`m.plugin ?? m.default ?? m\` — this named
// alias is what BARNACLE_PLUGINS finds; without it the loader would fall
// through to \`m.default\` (the response schema above) and 404 at runtime.
export { ${camel}Plugin as plugin };
`;
}

/** A flow step as read from recon-flow.json, carrying the optional splicer hints. */
type FlowStepInput =
  | string
  | {
      step: string;
      optional?: boolean;
      upload?: boolean;
      submitStep?: boolean;
      payloadField?: string;
      payloadFieldNone?: boolean;
    };

/**
 * Escape a literal string segment so it is safe INSIDE a JS backtick template
 * literal — backslashes, backticks, and `${` interpolation starts must all be
 * neutralized so the only interpolation the emitted flow performs is the
 * `${payload.X}` splice we insert deliberately.
 */
function escapeForTemplateLiteral(segment: string): string {
  return segment.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

/**
 * Build the emitted instruction expression for one step: a plain double-quoted
 * literal when nothing splices, or a backtick template literal with the recon
 * constant replaced by `${payload.<field>}` when the resolver picks a field.
 * The first `${RECON_EMAIL}` token (preferred) or the first single-quoted
 * literal in the instruction is the splice site.
 */
function buildStepInstructionExpr(instruction: string, field: string | null): string {
  if (field === null) return JSON.stringify(instruction);
  // Concatenated so Biome's noTemplateCurlyInString doesn't flag the literal
  // env-var token — it must stay `${RECON_EMAIL}` to match recon's flow files.
  const emailToken = `$${"{RECON_EMAIL}"}`;
  const emailIdx = instruction.indexOf(emailToken);
  const [before, matched, after] =
    emailIdx >= 0
      ? [
          instruction.slice(0, emailIdx),
          emailToken,
          instruction.slice(emailIdx + emailToken.length),
        ]
      : (() => {
          const m = /'[^']*'/.exec(instruction);
          if (m === null) return [instruction, "", ""] as const;
          return [
            instruction.slice(0, m.index),
            m[0],
            instruction.slice(m.index + m[0].length),
          ] as const;
        })();
  if (matched === "") return JSON.stringify(instruction);
  return `\`${escapeForTemplateLiteral(before)}\${payload.${field}}${escapeForTemplateLiteral(after)}\``;
}

/**
 * Rewrites one step instruction into the config-manifest templating form:
 * the recon splice site (a `${RECON_EMAIL}` token or the first single-quoted
 * literal) becomes `{{ .request.<field> }}`. Unlike {@link buildStepInstructionExpr}
 * this yields a plain manifest string, not a TS expression — the runtime
 * config-plugin resolver, not the code generator, performs the splice.
 */
function buildManifestInstruction(instruction: string, field: string | null): string {
  if (field === null) return instruction;
  const emailToken = `$${"{RECON_EMAIL}"}`;
  const emailIdx = instruction.indexOf(emailToken);
  if (emailIdx >= 0) {
    return (
      instruction.slice(0, emailIdx) +
      `{{ .request.${field} }}` +
      instruction.slice(emailIdx + emailToken.length)
    );
  }
  const m = /'[^']*'/.exec(instruction);
  if (m === null) return instruction;
  return (
    instruction.slice(0, m.index) +
    `{{ .request.${field} }}` +
    instruction.slice(m.index + m[0].length)
  );
}

/**
 * The JSON Schema `type` keyword for a sample value. Just the keyword, not a
 * full schema: the manifest is a scaffold a human narrows, so it needs the real
 * type a caller must send (`page` is a number, `filters` an array) without
 * duplicating {@link inferZodSchema}'s recursive shape inference. `null` and
 * `undefined` fall back to `string`, the safe default for a field a caller fills.
 */
function jsonSchemaTypeOf(value: unknown): "string" | "number" | "boolean" | "array" | "object" {
  if (Array.isArray(value)) return "array";
  if (value === null || value === undefined) return "string";
  const t = typeof value;
  if (t === "number") return "number";
  if (t === "boolean") return "boolean";
  if (t === "object") return "object";
  return "string";
}

/**
 * Emits a config-only plugin manifest (`<siteId>.plugin.json`) from the recon
 * flow, as an alternative to the `.ts` trio for browser-only sites. Reuses the
 * SAME `resolveStepPayloadField` splice logic as the browser-flow emitter, so
 * every `{{ .request.<field> }}` reference also lands in the manifest's request
 * schema — the two cannot drift.
 *
 * `recovered` carries the request contract the `.ts` path infers from real
 * captures — the first POST body's fields plus form-schema discoveries — so
 * `--emit config` no longer throws that away and emit a request schema built
 * only from the handful of flow-step splice hints. The direct-HTTP hot path is
 * still omitted; a site that needs it keeps the `.ts` path or wires
 * `spec.httpModule` by hand.
 */
export function emitConfigManifest(opts: {
  siteId: string;
  displayName: string;
  baseUrl: string;
  flowSteps: FlowStepInput[];
  vocabulary?: ReconVocabulary;
  /** First action body: its top-level keys are the caller's real request fields. */
  inputBody?: unknown;
  /** Form-schema fields the recon recovered, added as caller-supplied strings. */
  recoveredFields?: Iterable<string>;
}): string {
  const { siteId, displayName, baseUrl, flowSteps, vocabulary, inputBody, recoveredFields } = opts;
  const payloadFieldNames = new Set<string>();

  const steps = flowSteps.map((step) => {
    const isObj = typeof step !== "string";
    const instruction = isObj ? step.step : step;
    const field = resolveStepPayloadField(
      instruction,
      isObj ? step.payloadField : undefined,
      isObj ? step.payloadFieldNone : undefined,
      vocabulary
    );
    if (field !== null) payloadFieldNames.add(field);
    const rewritten = buildManifestInstruction(instruction, field);
    const optional = isObj ? step.optional === true : false;
    const upload = isObj ? step.upload === true : false;
    const submitStep = isObj ? step.submitStep === true : false;
    if (!optional && !upload && !submitStep) return rewritten;
    return { step: rewritten, optional, upload, submitStep };
  });

  // The request surface, widest wins: a flow splice, a recovered form field, or
  // a key from the first POST body all name something a caller controls. Splices
  // and recovered fields are strings (the browser flow fills them as text); a
  // body key keeps its captured type so a caller sends `page: 1`, not `"1"`.
  const requestProperties: Record<string, { type: string }> = {};
  for (const name of payloadFieldNames) requestProperties[name] = { type: "string" };
  for (const name of recoveredFields ?? []) requestProperties[name] = { type: "string" };
  if (inputBody !== null && typeof inputBody === "object" && !Array.isArray(inputBody)) {
    for (const [name, value] of Object.entries(inputBody)) {
      requestProperties[name] = { type: jsonSchemaTypeOf(value) };
    }
  }
  const sortedRequestProperties = Object.fromEntries(
    Object.keys(requestProperties)
      .sort()
      .map((name) => [name, requestProperties[name]])
  );

  const manifest = {
    apiVersion: CONFIG_PLUGIN_API_VERSION,
    kind: CONFIG_PLUGIN_KIND,
    metadata: { siteId, displayName },
    spec: {
      defaultBaseUrl: baseUrl,
      request: { type: "object", properties: sortedRequestProperties },
      response: {
        type: "object",
        description: "TODO: declare the fields this site returns (recon leaves this empty).",
        properties: {},
      },
      flow: { steps },
      extract: {
        instruction: `extract the confirmation id and status for ${siteId}`,
        schema: {
          type: "object",
          description: "TODO: declare the fields to extract (empty extracts nothing at runtime).",
          properties: {},
        },
      },
    },
  };

  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * Emit the generated browser-flow module and return the accumulated set of
 * spliced payload-field names. Exported so the anti-drift unit test can assert
 * every `payload.<field>` the flow references also appears in the contract's
 * payload schema (both are driven by this same set).
 */
export function emitBrowserFlowTs(opts: {
  siteId: string;
  pascal: string;
  baseUrl: string;
  flowSteps: FlowStepInput[];
  isSubmissionFlow: boolean;
  hasMultipartStep?: boolean;
  vocabulary?: ReconVocabulary;
}): { code: string; payloadFieldNames: Set<string> } {
  const {
    siteId,
    pascal,
    flowSteps,
    isSubmissionFlow,
    hasMultipartStep = false,
    vocabulary,
  } = opts;

  const payloadFieldNames = new Set<string>();
  const hasUploadStep = flowSteps.some((s) => typeof s !== "string" && s.upload === true);

  const stepLiterals = flowSteps.map((step) => {
    const isObj = typeof step !== "string";
    const instruction = isObj ? step.step : step;
    const field = resolveStepPayloadField(
      instruction,
      isObj ? step.payloadField : undefined,
      isObj ? step.payloadFieldNone : undefined,
      vocabulary
    );
    if (field !== null) payloadFieldNames.add(field);
    const instructionExpr = buildStepInstructionExpr(instruction, field);
    const optional = isObj ? step.optional === true : false;
    const upload = isObj ? step.upload === true : false;
    const submitStep = isObj ? step.submitStep === true : false;
    return `  { instruction: ${instructionExpr}, optional: ${optional}, upload: ${upload}, submitStep: ${submitStep} },`;
  });

  const flowStepsBlock =
    stepLiterals.length > 0
      ? stepLiterals.join("\n")
      : `  // TODO: add flow steps from src/sites/${siteId}/recon-flow.json`;

  // Wire a resumeFixture from the payload's Resume/ResumeFilename/
  // ResumeContentType fields ONLY when the contract actually carries them
  // (hasMultipartStep) AND the flow uploads. When a flow has an upload step but
  // the captures weren't detected as multipart (e.g. a GraphQL site where
  // multipart detection is dropped), those payload fields don't exist yet — emit
  // a null + TODO so the generated module still typechecks; the operator adds
  // the multipart contract fields and wires the fixture during hand-finish.
  const resumeFixtureExpr =
    hasUploadStep && hasMultipartStep
      ? `{
    buffer: Buffer.from(payload.Resume ?? "", "base64"),
    name: payload.ResumeFilename ?? "resume.pdf",
    mimeType: payload.ResumeContentType ?? "application/pdf",
  }`
      : hasUploadStep
        ? `null /* TODO: this flow uploads, but the contract has no Resume multipart\n    fields yet. Add Resume/ResumeFilename/ResumeContentType to the payload\n    schema (set meta.multipart:true) and build the fixture from payload here. */`
        : "null";

  const code = `/**
 * Generated by recon-generate.ts — Stagehand browser fallback for ${siteId}.
 * Core invokes this automatically when executeHttp throws HttpSchemaError or
 * HttpBotChallengeError. Update the flow steps and extract schema as needed.
 *
 * Steps whose instruction named a candidate PII label have their recon
 * constant spliced to \`payload.<field>\` so the caller's real applicant reaches
 * the page; operational-default steps stay literal. The steps run through the
 * self-heal cascade via runHealingFlow — the same engine the recon CLI uses,
 * minus its disk-dump/replan layer.
 */

import type { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod/v4";

import { buildAnthropicClient } from "${ENGINE_PKG}/lib/llm/anthropic-client";
import { getLogger } from "${ENGINE_PKG}/lib/logging";
import { type HealingFlowStep, runHealingFlow, waitForSpaReady } from "${ENGINE_PKG}/scraper/flow-runner";
import { guardedExtract } from "${ENGINE_PKG}/scraper/stagehand-guard";
import type { ${pascal}Payload, ${pascal}Response } from "@/sites/${siteId}/contract";

const logger = getLogger({ name: "${siteId}-browser-flow" });

const ${pascal}BrowserSchema = z.object({
  // TODO: define the fields you need — align with ${pascal}Response
  extraction: z.string(),
});

/**
 * Drives ${siteId} through the recon flow and extracts structured data. This is
 * the browser path; if contract.ts also defines executeHttp, that hot path runs
 * first and this is the fallback — otherwise this IS the production path.
 */
export async function run${pascal}BrowserFlow(
  stagehand: Stagehand,
  baseUrl: string,
  payload: ${pascal}Payload
): Promise<${pascal}Response> {
  const page = await stagehand.context.awaitActivePage();

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  // networkidle can resolve before a Cloudflare-fronted SPA hydrates; wait for
  // the real DOM so the first steps don't probe an empty shell page and skip.
  await waitForSpaReady(page, logger);

  const FLOW_STEPS: HealingFlowStep[] = [
${flowStepsBlock}
  ];

  // buildAnthropicClient() enables the cascade's attempt-5 rephrase + replan to
  // recover a stuck step; null on a Bedrock-only deployment, where the cascade
  // degrades to its deterministic DOM primitives.
  await runHealingFlow({
    stagehand,
    page,
    steps: FLOW_STEPS,
    logger,
    anthropic: buildAnthropicClient(),
    resumeFixture: ${resumeFixtureExpr},
  });

  // Schema-enforced extract via guardedExtract: Stagehand 3.4.0 accepts
  // both Zod v3 and v4 schemas natively (StagehandZodSchema union since
  // 2.4.3 / PR #944), and the caller-side safeParse defends against SDK
  // contract drift. Widen ${pascal}BrowserSchema as needed to match the
  // fields the recon flow actually surfaces.
  const result = await guardedExtract(
    stagehand,
    ${isSubmissionFlow ? `\`drove the ${siteId} submission flow for payload \${JSON.stringify(payload)}\`` : `\`extract results matching query: \${payload.query}\``},
    ${pascal}BrowserSchema
  );

  return result as unknown as ${pascal}Response;
}
`;
  return { code, payloadFieldNames };
}

/** Generates the site's index.ts barrel — exported so the out-of-tree e2e
 * test can drive the emitter directly without spawning the CLI. */
export function emitIndexTs(opts: { siteId: string; pascal: string }): string {
  const { siteId } = opts;
  const camel = siteId.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
  return `/**
 * Generated by recon-generate.ts.
 * Build this package, then point BARNACLE_PLUGINS at the compiled module —
 * no core edits required:
 *
 *   BARNACLE_PLUGINS=./dist/sites/${siteId}/index.js pnpm start
 *
 * The loader resolves \`m.plugin ?? m.default ?? m\` — the \`plugin\` alias
 * below is what it finds.
 */

export { ${camel}Plugin, ${camel}Plugin as plugin } from "@/sites/${siteId}/contract";
`;
}

// ── main ──────────────────────────────────────────────────────────────────────

/**
 * Resolves the vocabulary for this run and reports which one is in play.
 *
 * The deprecation warning is the whole point of the 1.x window: removing a
 * built-in default that consumers silently depend on is only safe if the
 * transition is loud. It fires only when the built-in would actually change the
 * output — a flow with nothing to splice gets no nag it can't act on.
 */
async function resolveVocabulary(
  specifier: string,
  flowSteps: FlowStepInput[]
): Promise<ReconVocabulary> {
  if (specifier) {
    const vocabulary = await loadReconVocabulary(specifier, process.cwd());
    logger.info(
      `vocabulary: ${specifier === VOCABULARY_NONE ? "none (splicing disabled)" : `${vocabulary.table.length} row(s) from ${specifier}`}`
    );
    return vocabulary;
  }

  // Warn only when the built-in table itself changes the outcome. A step with an
  // explicit payloadField resolves the same under any vocabulary, so nagging
  // about it would send consumers to fix something that isn't broken.
  const builtinChangesOutcome = flowSteps.some((step) => {
    const isObj = typeof step !== "string";
    const instruction = isObj ? step.step : step;
    const explicit = isObj ? step.payloadField : undefined;
    const forceNone = isObj ? step.payloadFieldNone : undefined;
    const withBuiltin = resolveStepPayloadField(
      instruction,
      explicit,
      forceNone,
      DEPRECATED_BUILTIN_ATS_VOCABULARY
    );
    const withNothing = resolveStepPayloadField(instruction, explicit, forceNone, EMPTY_VOCABULARY);
    return withBuiltin !== withNothing;
  });
  if (builtinChangesOutcome) {
    logger.warn(
      `DeprecationWarning: no --vocabulary given, falling back to the built-in recruiting table. ` +
        `It is removed in 2.0.0, after which this is an error. Fix: create a vocabulary module ` +
        `exporting a ReconVocabulary (see @enricai/barnacle/recon/vocabulary) and pass ` +
        `--vocabulary ./src/recon/<name>.ts, or --vocabulary none if this site splices no caller data.`
    );
  }
  return DEPRECATED_BUILTIN_ATS_VOCABULARY;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let siteId = "";
  let force = false;
  let emit: "ts" | "config" = "ts";
  let vocabularySpecifier = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--site-id" && args[i + 1]) siteId = args[++i]!;
    else if (args[i] === "--vocabulary" && args[i + 1]) vocabularySpecifier = args[++i]!;
    else if (args[i] === "--force") force = true;
    else if (args[i] === "--emit" && args[i + 1]) {
      const value = args[++i]!;
      if (value !== "ts" && value !== "config") {
        logger.error(`--emit must be "ts" or "config", got ${JSON.stringify(value)}`);
        process.exit(1);
      }
      emit = value;
    }
  }

  if (!siteId) {
    logger.error("--site-id <id> is required");
    process.exit(1);
  }

  const outDir = `src/sites/${siteId}`;
  const manifestPath = `src/sites/${siteId}/${siteId}.plugin.json`;

  if (emit === "ts" && existsSync(outDir) && !force) {
    logger.error(`${outDir} already exists — pass --force to overwrite`);
    process.exit(1);
  }
  if (emit === "config" && existsSync(manifestPath) && !force) {
    logger.error(`${manifestPath} already exists — pass --force to overwrite`);
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
      const raw: unknown = JSON.parse(readFileSync(flowFile, "utf8"));
      if (Array.isArray(raw)) return raw as FlowStepInput[];
      if (
        raw !== null &&
        typeof raw === "object" &&
        "steps" in raw &&
        Array.isArray((raw as { steps: unknown }).steps)
      ) {
        return (raw as { steps: FlowStepInput[] }).steps;
      }
      return [] as string[];
    } catch {
      return [] as string[];
    }
  })();

  // Resolved once and threaded down, never captured into a module const: a
  // module-level const would freeze at import time, which is the bug that makes
  // RECON_QUESTION_KEYWORDS silently inert for anyone setting it after load.
  const vocabulary = await resolveVocabulary(vocabularySpecifier, flowSteps);

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
  const rawActionCaptures = gql
    ? []
    : collapseRedundantPatches(extractActionSequence(captures, baseUrl));
  // Form-schema detection runs BEFORE state-indexing so the FieldId/OptionId
  // UUIDs can be shielded from indexing — those UUIDs are stable schema
  // anchors that T2/T3 substitution depends on remaining literal in body
  // templates.
  const { fieldNameMap, fieldOptionsMap, allSchemaUuids } = detectFormSchemaFieldNames(captures);
  // Shield ALL FieldId/OptionId UUIDs that appear in any schema response, not
  // just the ones that detectFormSchemaFieldNames emits a payload name for.
  // Some fields have FieldNames too long for the naming heuristic (>80 chars)
  // and would be skipped by fieldNameMap; their FieldIds still need shielding
  // because they appear as anchors in the T2-substituted body templates.
  const shieldedUuids = new Set<string>(allSchemaUuids);
  // T4 — Phase B+C: detect a form-schema GET capture and insert it into the
  // action sequence at the position observed during recon, so the existing
  // state-threading machinery can produce its FormHistoryId / section UUIDs /
  // etc. as state values for downstream POSTs. Strip cache-buster query
  // params (recon timestamps) from the captured URL so the emitted runtime
  // fetch uses a clean template. Sites without a schema-fetch capture
  // (rawSchemaFetch === null) get unchanged behavior.
  const rawSchemaFetch = gql ? null : detectFormSchemaFetchCapture(captures, baseUrl);
  const schemaFetchCleaned: Capture | null = rawSchemaFetch
    ? { ...rawSchemaFetch.capture, url: stripCacheBusterParams(rawSchemaFetch.capture.url) }
    : null;
  const actionCaptures: ActionCapture[] = (() => {
    if (rawActionCaptures.length === 0 || schemaFetchCleaned === null || rawSchemaFetch === null) {
      return rawActionCaptures;
    }
    let insertAt = rawActionCaptures.length;
    for (let i = 0; i < rawActionCaptures.length; i++) {
      if (rawActionCaptures[i]!.index >= rawSchemaFetch.index) {
        insertAt = i;
        break;
      }
    }
    return [
      ...rawActionCaptures.slice(0, insertAt),
      { capture: schemaFetchCleaned, index: rawSchemaFetch.index },
      ...rawActionCaptures.slice(insertAt),
    ];
  })();
  const actionCaptureIndices = new Set<number>(actionCaptures.map((a) => a.index));
  const stateIndex =
    actionCaptures.length > 1
      ? indexStateValues(captures, shieldedUuids, actionCaptureIndices)
      : new Map<string, StateValue>();
  const actionSteps =
    actionCaptures.length > 1 ? compileActionSteps(actionCaptures, stateIndex) : [];
  const isSubmissionFlow = actionSteps.length > 1;

  const inputBody = isSubmissionFlow
    ? (() => {
        try {
          const payloadAction = selectPayloadAction(actionSteps);
          return JSON.parse(payloadAction?.capture.requestPostData ?? "null") as unknown;
        } catch {
          return null;
        }
      })()
    : undefined;
  const errorSignals = detectErrorSignals(actionSteps);
  const discoveredFormFields = new Set<string>();
  const discoveredOptionFields = new Set<string>();
  // Phase E: maps FieldName-derived raw-option payload field name (e.g.
  // "AreYouOverTheAgeOf18OptionId") → recon-observed OptionId UUID. Used to
  // emit `<FieldName>OptionId: z.string()` payload fields with TSDoc docs.
  const discoveredRawOptionFields = new Map<string, string>();
  // Phase F: keys from additional action POST bodies (beyond inputBody/r0)
  // that get parameterized. Recorded with their value type so the contract
  // emitter can add them to the payload schema with appropriate Zod types.
  const discoveredAdditionalBodyKeys = new Map<string, "string" | "number" | "boolean">();
  // G1+G2: partition baseHeaders into three buckets:
  //   - static: values that don't reference baseUrl or tenant subdomain
  //   - baseUrl-derived: values containing the recon's baseUrl as substring
  //     (e.g. Origin, Referer) — emit per-call from payload.BaseUrl
  //   - tenant-subdomain: values that EXACTLY equal the first subdomain
  //     (e.g. API-ShortName: "addus") — emit per-call from a payload field
  const staticBaseHeaders: Record<string, string> = {};
  const baseUrlDerivedHeaders = new Map<string, string>();
  const tenantSubdomainHeaders = new Map<string, string>();
  const firstSubdomain = (() => {
    try {
      const host = new URL(baseUrl).hostname;
      const firstDot = host.indexOf(".");
      return firstDot === -1 ? host : host.slice(0, firstDot);
    } catch {
      return "";
    }
  })();
  for (const [k, v] of Object.entries(baseHeaders)) {
    if (firstSubdomain.length > 0 && v === firstSubdomain) {
      tenantSubdomainHeaders.set(k, v);
    } else if (baseUrl.length > 0 && v.includes(baseUrl)) {
      baseUrlDerivedHeaders.set(k, v);
    } else {
      staticBaseHeaders[k] = v;
    }
  }
  const multiStepBody = isSubmissionFlow
    ? emitMultiStepExecuteHttp(
        actionSteps,
        inputBody,
        errorSignals,
        fieldNameMap,
        discoveredFormFields,
        fieldOptionsMap,
        discoveredOptionFields,
        discoveredRawOptionFields,
        discoveredAdditionalBodyKeys,
        baseUrl,
        baseUrlDerivedHeaders,
        tenantSubdomainHeaders
      )
    : undefined;

  let base64ContentHelper = "";
  const base64PatchOverride = new Map<string, string>();

  if (isSubmissionFlow && actionSteps.length > 0) {
    const lastPatchWithContent = [...actionSteps]
      .reverse()
      .find(
        (s) =>
          s.capture.method === "PATCH" &&
          s.capture.requestPostData &&
          /"Content":"ey[A-Za-z0-9+/=]{100,}"/.test(s.capture.requestPostData)
      );
    if (lastPatchWithContent) {
      const b64Match = lastPatchWithContent.capture.requestPostData!.match(
        /"Content":"(ey[A-Za-z0-9+/=]{100,})"/
      );
      if (b64Match) {
        const b64 = b64Match[1]!;
        const qMapping = buildQuestionnaireMapping(captures);
        const personaValues = new Map<string, string>();
        const firstPost = captures.find(
          (c) =>
            c.method === "POST" &&
            c.url.includes("recruitingCEJobApplicationDrafts") &&
            c.requestPostData
        );
        if (firstPost?.requestPostData) {
          try {
            const pb = JSON.parse(firstPost.requestPostData) as Record<string, unknown>;
            if (typeof pb.EmailAddress === "string")
              personaValues.set(pb.EmailAddress, "payload.Email");
          } catch {
            /* skip */
          }
        }

        base64ContentHelper = emitBuildBase64ContentFunction(b64, personaValues, qMapping, pascal);

        base64PatchOverride.set(
          lastPatchWithContent.varName,
          // biome-ignore lint/suspicious/noTemplateCurlyInString: emitted as generated template-literal source
          '"Content":"${buildBase64Content(payload, questionnaireId, Number(draftId), String(attachmentId))}"'
        );

        const draftPostStep = actionSteps.find(
          (s) =>
            s.capture.method === "POST" &&
            s.capture.url.includes("recruitingCEJobApplicationDrafts")
        );
        if (draftPostStep && !draftPostStep.produces.some((p) => p.name === "draftId")) {
          draftPostStep.produces.push({
            kind: "body",
            name: "draftId",
            pathExpr: `${draftPostStep.varName}.APPDraftId`,
            path: ["APPDraftId"],
          });
        }

        const attachPostStep = actionSteps.find(
          (s) => s.capture.method === "POST" && s.capture.url.includes("/attachments")
        );
        if (attachPostStep && !attachPostStep.produces.some((p) => p.name === "attachmentId")) {
          attachPostStep.produces.push({
            kind: "body",
            name: "attachmentId",
            pathExpr: `${attachPostStep.varName}.Id`,
            path: ["Id"],
          });
        }

        const questionnaireCapture = captures.find(
          (c) =>
            c.method === "GET" &&
            c.url.includes("recruitingCEQuestions") &&
            c.url.includes("expand=answers")
        );
        let sampleQid: number | undefined;
        if (questionnaireCapture) {
          const qResp =
            typeof questionnaireCapture.responseBody === "string"
              ? (JSON.parse(questionnaireCapture.responseBody) as {
                  items?: Array<{ QuestionnaireId?: number }>;
                })
              : (questionnaireCapture.responseBody as {
                  items?: Array<{ QuestionnaireId?: number }>;
                } | null);
          sampleQid = qResp?.items?.[0]?.QuestionnaireId ?? undefined;
        }

        const overrideValue = base64PatchOverride.values().next().value as string;
        if (overrideValue) {
          const extraVarLines: string[] = [];
          if (sampleQid) {
            extraVarLines.push(`    const questionnaireId = ${sampleQid};`);
          }
          if (!attachPostStep) {
            extraVarLines.push(`    const attachmentId = "";`);
          }
          if (extraVarLines.length > 0) {
            base64PatchOverride.set("__EXTRA_VARS__", extraVarLines.join("\n"));
          }
        }

        const answersFields = (qMapping ?? []).map((m) => m.payloadField);
        answersFields.push("SignatureFullName");
        const answersSchemaFields = answersFields.map((f) => `    ${f}: z.string(),`).join("\n");
        base64ContentHelper = `\nconst AnswersSchema = z.object({\n${answersSchemaFields}\n});\n${base64ContentHelper}`;

        const inputKeys = new Set<string>();
        if (inputBody && typeof inputBody === "object" && !Array.isArray(inputBody)) {
          for (const k of Object.keys(inputBody as Record<string, unknown>)) inputKeys.add(k);
        }
        for (const fld of ["FirstName", "LastName", "Email", "Phone"]) {
          if (!inputKeys.has(fld)) discoveredAdditionalBodyKeys.set(fld, "string");
        }
      }
    }
  }

  const processedMultiStepBody = isSubmissionFlow
    ? emitMultiStepExecuteHttp(
        actionSteps,
        inputBody,
        errorSignals,
        fieldNameMap,
        discoveredFormFields,
        fieldOptionsMap,
        discoveredOptionFields,
        discoveredRawOptionFields,
        discoveredAdditionalBodyKeys,
        baseUrl,
        baseUrlDerivedHeaders,
        tenantSubdomainHeaders,
        base64PatchOverride
      )
    : multiStepBody;

  const hasMultipartStep = actionSteps.some((s) => s.isMultipart);
  const headerBindings = collectHeaderBindings(actionSteps);
  // For submission flows the final action's response body is the most useful
  // shape inference target (it's the terminal success signal). Fall back to
  // the replay body for single-endpoint sites.
  const effectiveResponseBody = isSubmissionFlow
    ? (actionSteps[actionSteps.length - 1]!.capture.responseBody ?? responseBody)
    : responseBody;

  logger.info(
    `generating plugin for ${siteId} (${gql ? "GraphQL" : isSubmissionFlow ? `submission flow, ${actionSteps.length} steps` : "single-endpoint REST"}, baseUrl: ${baseUrl})`
  );

  if (emit === "config") {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      manifestPath,
      emitConfigManifest({
        siteId,
        displayName: pascal,
        baseUrl,
        flowSteps,
        vocabulary,
        inputBody,
        recoveredFields: [...discoveredFormFields, ...discoveredOptionFields],
      })
    );
    logger.info(`wrote ${manifestPath}`);
    logger.info(
      `done — review ${manifestPath}, fill in response/extract schemas, then load via BARNACLE_PLUGINS or BARNACLE_PLUGINS_CONFIG_DIR (no compile step)`
    );
    return;
  }

  mkdirSync(`${outDir}/flows`, { recursive: true });

  // Emit the browser flow first so the SAME payloadFieldNames set that drives
  // its `payload.<field>` splices also extends the contract's payload schema —
  // the two artifacts can't drift because one accumulator feeds both.
  const browserFlow = emitBrowserFlowTs({
    siteId,
    pascal,
    baseUrl,
    flowSteps,
    isSubmissionFlow,
    hasMultipartStep,
    vocabulary,
  });

  writeFileSync(
    `${outDir}/contract.ts`,
    emitContractTs({
      siteId,
      pascal,
      baseUrl,
      // G1+G2: only the static headers (no baseUrl/tenant-subdomain references)
      // get baked into BASE_HEADERS. The rest are emitted per-call from payload.
      baseHeaders: isSubmissionFlow ? staticBaseHeaders : baseHeaders,
      minTime,
      safeRps,
      responseBody: effectiveResponseBody,
      gql,
      gqlQuery,
      endpointPath,
      auxFiles,
      multiStepBody: processedMultiStepBody,
      base64ContentHelper,
      inputBody,
      hasMultipartStep,
      discoveredFormFields,
      fieldOptionsMap,
      discoveredOptionFields,
      discoveredRawOptionFields,
      discoveredAdditionalBodyKeys,
      payloadFieldNames: browserFlow.payloadFieldNames,
      headerBindings,
    })
  );
  logger.info(`wrote ${outDir}/contract.ts`);

  writeFileSync(`${outDir}/flows/browser-flow.ts`, browserFlow.code);
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

if (
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("recon-generate.ts") || process.argv[1].endsWith("recon-generate.js"))
) {
  main().catch((err: unknown) => {
    logger.error(`recon-generate failed: ${toErrorMessage(err)}`);
    process.exit(1);
  });
}
