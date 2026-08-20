/**
 * Phase 4f: reads recon artifacts and generates a complete plugin skeleton —
 * contract.ts, flows/browser-flow.ts, index.ts, and fixtures/ — so no manual
 * coding is required between running recon and registering the plugin.
 *
 * Usage:
 *   pnpm run recon:generate -- --site-id my-site [--run-dir <path>] [--force]
 *
 * --force overwrites an existing src/sites/<siteId>/ directory.
 * --run-dir selects which run root to read; defaults to the most recently
 * modified run root under the recon output base dir (see
 * {@link resolveLatestReconRunRoot}), so the existing two-command
 * "recon, then generate" workflow keeps working unchanged.
 *
 * Reads from (under the resolved run root):
 *   graphql/*.json        — Capture[] from recon-browser.ts
 *   replays/*.json        — ReplayResult[] from recon-http.ts
 *   replays/rate-limit.json
 *   aux/*.json            — static fixture files
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
import { isNoiseUrl, telemetryUrlPatterns } from "@/recon/capture-filters";
import type { ReconFormSchema } from "@/recon/form-schema";
import { FORM_SCHEMA_NONE, loadReconFormSchema } from "@/recon/load-form-schema";
import { loadReconVocabulary, VOCABULARY_NONE } from "@/recon/load-vocabulary";
import { EMPTY_VOCABULARY, type ReconVocabulary } from "@/recon/vocabulary";
import {
  type Capture,
  type RateLimitFinding,
  type ReplayResult,
  readJsonDir,
  resolveLatestReconRunRoot,
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

/**
 * A reserved recon env token, e.g. `${RECON_EMAIL}` or `${RECON_PHONE}` — the
 * `RECON_` prefix is what marks a `${UPPER_SNAKE}` token as a recon-owned
 * splice site rather than an unrelated caller-authored env reference.
 */
const RESERVED_ENV_TOKEN = /\$\{RECON_[A-Z0-9_]*\}/;

/**
 * The reserved `${RECON_PASSWORD}` token. Unlike every other `RESERVED_ENV_TOKEN`
 * (RECON_EMAIL, RECON_PHONE, ...), which name a piece of the caller's real
 * applicant identity and so splice to a `payload.<field>` accessor, this one
 * names a credential the recon capture needed to authenticate but that has no
 * caller-supplied counterpart on the applicant payload — there is no "Password"
 * field to route it through. It gets its own reserved-tooling handling ahead of
 * (never through) vocabulary/payload-field resolution.
 */
const RECON_PASSWORD_TOKEN = `$${"{RECON_PASSWORD}"}`;

/**
 * Masks the apostrophe in a possessive `'s` (e.g. "the candidate's name") with
 * a non-quote placeholder of the same length, so a naive `'...'` quote scan
 * doesn't mistake the possessive apostrophe for an opening quote delimiter.
 * Length-preserving so callers that need positions in the ORIGINAL instruction
 * can reuse the indices matched against the masked string unchanged.
 */
function maskPossessiveApostrophes(instruction: string): string {
  return instruction.replace(/(\w)'(s\b)/g, "$1 $2");
}

/** One `'...'` quoted span found in an instruction, with its position in the ORIGINAL string. */
interface QuoteSpan {
  index: number;
  length: number;
  value: string;
}

function findQuoteSpans(instruction: string): QuoteSpan[] {
  const masked = maskPossessiveApostrophes(instruction);
  return [...masked.matchAll(/'([^']*)'/g)].map((m) => ({
    index: m.index,
    length: m[0].length,
    value: instruction.slice(m.index + 1, m.index + m[0].length - 1),
  }));
}

/**
 * Picks which quoted span in an instruction is the persona VALUE, per the
 * grammar recon-flow steps use: a `Select`/`Choose`/`Pick` step names the
 * ANSWER first, then the question, so the value is the FIRST quoted span; a
 * `Fill`/`Enter`/`Type` step names the field label first and the value last,
 * so it is the LAST quoted span.
 */
function pickValueSpan(instruction: string, spans: readonly QuoteSpan[]): QuoteSpan {
  return /^\s*(select|choose|pick)\b/i.test(instruction) ? spans[0]! : spans[spans.length - 1]!;
}

/**
 * Locates the splice site in a flow-step instruction as `{ before, matched,
 * after }` slices of the ORIGINAL instruction — a reserved `${RECON_*}` env
 * token when present (preferred, since it names its own site unambiguously),
 * otherwise the quoted VALUE span per {@link pickValueSpan}'s verb-class rule.
 * This is the position-aware counterpart to {@link extractStepPersonaValue}:
 * that function only needs the extracted string, this one needs the actual
 * before/after slices so a template literal can be rebuilt around the site.
 *
 * @returns null when the instruction carries no spliceable site
 */
function locateSpliceSite(
  instruction: string
): { before: string; matched: string; after: string } | null {
  const envToken = RESERVED_ENV_TOKEN.exec(instruction);
  if (envToken) {
    return {
      before: instruction.slice(0, envToken.index),
      matched: envToken[0],
      after: instruction.slice(envToken.index + envToken[0].length),
    };
  }
  const spans = findQuoteSpans(instruction);
  if (spans.length === 0) return null;
  const span = pickValueSpan(instruction, spans);
  return {
    before: instruction.slice(0, span.index),
    matched: instruction.slice(span.index, span.index + span.length),
    after: instruction.slice(span.index + span.length),
  };
}

function toPascalCase(siteId: string): string {
  return siteId
    .split(/[-_]/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}

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
 * @param vocabulary the consumer's domain vocabulary; defaults to {@link EMPTY_VOCABULARY}
 *   (no splicing) when the caller passes none
 * @returns the PascalCase payload field name to splice, or null to keep literal
 */
export function resolveStepPayloadField(
  instruction: string,
  explicit?: string,
  forceNone?: boolean,
  vocabulary: ReconVocabulary = EMPTY_VOCABULARY
): string | null {
  if (forceNone) return null;
  if (explicit) return explicit;
  // A quoted literal or a reserved ${RECON_*} env token IS the recon constant
  // this step would replace, so it is spliceable on its own.
  const hasQuotedConstant = /'[^']*'/.test(instruction) || RESERVED_ENV_TOKEN.test(instruction);
  // A dropdown step carries no constant to replace, so a label match alone can't
  // tell "select the test candidate's state" (the caller's data) from "select the
  // neighborhood from the Country dropdown" (a facet that merely says Country).
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
 * Extracts the concrete persona VALUE a flow step fills — the recon-supplied
 * constant that appears verbatim in the captured request body — so the body
 * emitter can bind it to `${payload.<field>}`. This is a stricter job than
 * {@link buildStepInstructionExpr}'s browser-flow splice, which only needs *a*
 * span to replace: here the extracted string must equal the wire value exactly,
 * or the value-identity substitution silently misses.
 *
 * Two grammar facts, both verified against real ATS flows, drive the rule:
 *   1. The possessive apostrophe in "the candidate's first name 'Reginald'"
 *      opens a false quote — a naive `/'[^']*'/` yields `s first name `, not
 *      `Reginald`. Neutralizing `\w's` → `\ws` before matching removes it.
 *   2. A `Select`/`Choose` step names the ANSWER first, then the question
 *      ("Select 'No' for the 'sponsorship' question"), so the value is the
 *      FIRST quoted token; a `Fill`/`Enter`/`Type` step names the field label
 *      first and the value last, so it is the LAST quoted token.
 * A `${RECON_EMAIL}` token (or the literal email `env` value) short-circuits to
 * the env-resolved address, matching recon-browser's own env substitution.
 *
 * @param instruction the flow step's plain-English instruction
 * @param env process env (or a stub) supplying `${VAR}` token values, e.g. RECON_EMAIL
 * @returns the persona value, or null when the step carries no spliceable constant
 */
export function extractStepPersonaValue(
  instruction: string,
  env: NodeJS.ProcessEnv
): string | null {
  const emailToken = `$${"{RECON_EMAIL}"}`;
  const reconEmail = env.RECON_EMAIL;
  if (reconEmail && (instruction.includes(emailToken) || instruction.includes(reconEmail))) {
    return reconEmail;
  }
  // Resolve any other `${UPPER_SNAKE}` env token the same way recon-browser's
  // substituteFlowEnvVars does, so an env-supplied value (e.g. RECON_PHONE) is
  // matched against the wire body by its runtime form, not the literal token.
  const envToken = /\$\{([A-Z_][A-Z0-9_]*)\}/.exec(instruction);
  if (envToken) {
    const resolved = env[envToken[1]!];
    if (resolved) return resolved;
  }
  const spans = findQuoteSpans(instruction);
  if (spans.length === 0) return null;
  const value = pickValueSpan(instruction, spans).value;
  return value.length > 0 ? value : null;
}

/**
 * Derives a payload field name from the field LABEL in a fill/enter/type
 * instruction, for steps the consumer vocabulary does not cover.
 *
 * WHY: `fill in the <LABEL> field with '<VALUE>'` is self-describing — the label
 * names the caller coordinate regardless of domain, so a vocabulary miss on a
 * legitimate identity field (a "middle name" a recruiting vocab forgot to list)
 * need not freeze the recon persona's value into every submission. This reads
 * only the generic instruction grammar; it hardcodes no field or site name.
 *
 * Scoped to Fill/Enter/Type by design. Those name the field label FIRST and a
 * quoted caller VALUE last, so a label→field claim is safe. Select/Choose name
 * the ANSWER first and often only a facet second ("select the neighborhood
 * from the Country dropdown") — deriving a field from the label there re-opens
 * the exact off-domain false-splice `ReconVocabulary.subject` exists to prevent,
 * so Select/Choose is deliberately excluded and stays vocabulary-gated.
 *
 * @param instruction the flow step's plain-English instruction
 * @returns the PascalCase field name, or null when the shape does not match
 */
export function deriveFillLabelField(instruction: string): string | null {
  if (!/^\s*(?:fill(?:\s+in)?|enter|type)\b/i.test(instruction)) return null;
  if (!/'[^']*'/.test(instruction)) return null;
  const label = /\b(?:fill(?:\s+in)?|enter|type)\s+(?:in\s+)?the\s+(.+?)\s+field\b/i.exec(
    instruction
  )?.[1];
  if (label === undefined) return null;
  return fieldNameToPascalCase(label, null);
}

/**
 * Builds the map from a recon persona VALUE (as it appears in the captured
 * request body) to the `payload.<Field>` accessor that should replace it, by
 * pairing each flow step's resolved field ({@link resolveStepPayloadField})
 * with its extracted value ({@link extractStepPersonaValue}). This is the
 * value→field reconciliation the browser flow and payload schema already do,
 * finally applied to the request-body templates.
 *
 * Earliest step wins on a duplicate value. Site-agnostic: the field mapping
 * lives entirely in the consumer's `--vocabulary`, with a generic
 * label-derivation ({@link deriveFillLabelField}) fallback for fill steps the
 * vocabulary doesn't recognize — the vocabulary always wins when it has a match.
 */
export function harvestPersonaBindings(
  flowSteps: FlowStepInput[],
  vocabulary: ReconVocabulary,
  env: NodeJS.ProcessEnv
): Map<string, string> {
  const bindings = new Map<string, string>();
  for (const step of flowSteps) {
    const isObj = typeof step !== "string";
    const instruction = isObj ? step.step : step;
    const vocabField = resolveStepPayloadField(
      instruction,
      isObj ? step.payloadField : undefined,
      isObj ? step.payloadFieldNone : undefined,
      vocabulary
    );
    // Vocabulary wins outright. Only on a miss do we fall back to deriving the
    // field from the instruction's own label — and never when the author opted
    // the step out (`payloadFieldNone`) or the vocabulary explicitly excluded it.
    const field =
      vocabField ??
      (isObj && step.payloadFieldNone
        ? null
        : vocabulary.exclusions.some((rx) => rx.test(instruction))
          ? null
          : deriveFillLabelField(instruction));
    if (field === null) continue;
    const value = extractStepPersonaValue(instruction, env);
    if (value === null) continue;
    if (!bindings.has(value)) bindings.set(value, `payload.${field}`);
  }
  return bindings;
}

/**
 * How deep to infer before collapsing to z.unknown(). Deep enough to reach the
 * fields that carry meaning on real inventory APIs — a listing's price
 * summary sits ~11 levels down inside products[].buildings[].units[] —
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
 * Finds actions whose endpoint was re-hit with a varying, non-void body —
 * the signature of a search/inventory endpoint the page queries repeatedly,
 * as opposed to an endpoint that merely fired once or repeated an identical
 * (retry) or void (chatter/beacon) call. Shared by `selectPayloadAction` and
 * `selectReturnAction`, which each pick a different fallback when nothing
 * was re-queried.
 */
function findRequeriedActions<T extends { capture: Capture }>(steps: readonly T[]): T[] {
  const bodiesByEndpoint = new Map<string, Set<string>>();
  for (const step of steps) {
    const key = endpointKey(step.capture.url);
    const bodies = bodiesByEndpoint.get(key) ?? new Set<string>();
    bodies.add(step.capture.requestPostData ?? "");
    bodiesByEndpoint.set(key, bodies);
  }

  return steps.filter((step) => {
    const bodies = bodiesByEndpoint.get(endpointKey(step.capture.url));
    if (!bodies || bodies.size < 2) return false;
    // An endpoint re-hit with varying bodies but nothing to show for it is
    // chatter — client-side error reporting, beacons — not the flow's subject.
    return !isVoidResponse(step.capture.responseBody);
  });
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

  const requeried = findRequeriedActions(steps);
  return requeried[0] ?? first;
}

/**
 * Picks the action whose response body `executeHttp` should return.
 *
 * Defaults to the last action, which is right for a transactional/submission
 * flow: the final call is the terminal success signal the caller wants back.
 * It is wrong when the flow is a read/search whose last call happens to be an
 * incidental drill-down (e.g. previewing one result) rather than the search
 * result itself — the same re-queried-endpoint signal `selectPayloadAction`
 * uses to find the flow's subject applies here: an endpoint hit repeatedly
 * with varying, non-void bodies is what the flow is about, and its most
 * recent response is the freshest instance of that answer.
 */
export function selectReturnAction<T extends { capture: Capture }>(steps: readonly T[]): T | null {
  const last = steps[steps.length - 1] ?? null;
  if (!last) return null;

  const requeried = findRequeriedActions(steps);
  return requeried[requeried.length - 1] ?? last;
}

/**
 * Picks the response body used to infer the emitted contract's response
 * shape. MUST target the same call `selectReturnAction` returns — a
 * submission flow's `executeHttp` and its inferred type/schema have to agree
 * on which call they describe, or the emitted type disagrees with the value
 * actually returned. Falls back to the replay body for single-endpoint sites.
 */
export function selectEffectiveResponseBody<T extends { capture: Capture }>(
  isSubmissionFlow: boolean,
  actionSteps: readonly T[],
  replayResponseBody: unknown
): unknown {
  if (!isSubmissionFlow) return replayResponseBody;
  return selectReturnAction(actionSteps)?.capture.responseBody ?? replayResponseBody;
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

/**
 * Extracts caller-supplied job/context coordinates from the recon ENTRY URL's
 * query string, mapping each param VALUE to a `payload.<param>` accessor. The
 * first capture is the landing navigation, and a submission flow's job context
 * (`?jobSeqNo=...`, `?jobId=...`) rides its query string — it belongs to the
 * target posting, not the recon run, so it must be caller-supplied. Values
 * below {@link MIN_STATE_VALUE_LENGTH} and cache-buster keys are skipped, since
 * a 1–7 char value collides with arbitrary substrings elsewhere in the body.
 *
 * Site-agnostic: reads only the entry URL's own query keys; no site-specific
 * param knowledge. Downstream, `interpolateStateValues`' length-descending pass
 * composes embedded substrings (a jobId inside a longer jobSeqNo) automatically.
 */
export function extractEntryUrlParams(entryUrl: string): Map<string, string> {
  const params = new Map<string, string>();
  let u: URL;
  try {
    u = new URL(entryUrl);
  } catch {
    return params;
  }
  for (const [key, value] of u.searchParams) {
    if (value.length < MIN_STATE_VALUE_LENGTH) continue;
    if (CACHE_BUSTER_QUERY_KEYS.has(key)) continue;
    if (!isValidJsIdentifier(key)) continue;
    if (!params.has(value)) params.set(value, `payload.${key}`);
  }
  return params;
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
 * headers (a `X-CSRF-Token`, a `Job-Boards-API-Token`, an `API-ShortName`,
 * etc.) without the generator needing to know about any particular site.
 */
function deriveRequestHeaders(
  captures: Capture[],
  replays: ReplayResult[],
  baseUrl: string,
  submitPatterns: SubmitPatterns | null = null
): Record<string, string> {
  const successfulUrls = new Set(replays.filter((r) => r.success).map((r) => endpointKey(r.url)));

  // Prefer ACTION captures (non-GET 2xx, non-noise) as the authoritative
  // header source. Replay-matched static-asset GETs lack the API-specific
  // headers that REST endpoints require, so falling back to those produces
  // a degenerate baseline-only header set. When action captures exist
  // (multi-step submission flows), use them. For sites where the flow is a
  // single REST call (no detectable action sequence), fall back to the
  // replay-matched captures.
  const actionCaptures = extractActionSequence(captures, submitPatterns).map((a) => a.capture);
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

interface PrimaryGraphQLOperation {
  capture: Capture;
  endpointPath: string;
}

/**
 * Ranks 2xx `query` (non-mutation) captures to find the primary data
 * operation of a read-only flow, replacing `firstGraphQLQuery`'s
 * chronologically-first fallback. Used only when {@link extractGraphQLActionSequence}
 * finds no mutations and the flow declares no `submitStep` — a transactional
 * flow keeps threading state through its mutation sequence unchanged.
 *
 * No single signal is trusted alone (a page-load query can be close in size to
 * the real one; a facet name can appear incidentally): response size, the
 * flow's own `payloadField` facets appearing in the candidate's query/variables,
 * a non-landing capture phase, and how often the same operation re-fires are
 * combined into one composite score.
 */
export function selectPrimaryGraphQLOperation(
  captures: Capture[],
  flowSteps: FlowStepInput[],
  vocabulary: ReconVocabulary
): PrimaryGraphQLOperation | null {
  const candidates = captures.filter(
    (c) => c.status >= 200 && c.status < 300 && c.query !== null && !/^\s*mutation\b/.test(c.query)
  );
  if (candidates.length === 0) return null;

  const payloadFields = new Set<string>();
  for (const step of flowSteps) {
    const isObj = typeof step !== "string";
    const instruction = isObj ? step.step : step;
    const field = resolveStepPayloadField(
      instruction,
      isObj ? step.payloadField : undefined,
      isObj ? step.payloadFieldNone : undefined,
      vocabulary
    );
    if (field !== null) payloadFields.add(field);
  }

  const responseSize = (c: Capture): number => {
    try {
      return JSON.stringify(c.responseBody ?? "").length;
    } catch {
      return 0;
    }
  };
  const fieldMatchCount = (c: Capture): number => {
    const haystack = `${c.query ?? ""} ${JSON.stringify(c.variables ?? "")}`.toLowerCase();
    let matches = 0;
    for (const field of payloadFields) {
      if (haystack.includes(field.toLowerCase())) matches++;
    }
    return matches;
  };
  const operationNameCounts = new Map<string, number>();
  for (const c of candidates) {
    if (c.operationName === null) continue;
    operationNameCounts.set(c.operationName, (operationNameCounts.get(c.operationName) ?? 0) + 1);
  }

  const maxSize = Math.max(...candidates.map(responseSize), 1);
  const maxFieldMatch = Math.max(...candidates.map(fieldMatchCount), 1);
  const maxRecurrence = Math.max(...Array.from(operationNameCounts.values()), 1);

  const scored = candidates.map((capture) => {
    const sizeScore = responseSize(capture) / maxSize;
    const fieldScore = fieldMatchCount(capture) / maxFieldMatch;
    const phaseScore = capture.phase !== "home" ? 1 : 0;
    const recurrenceScore =
      capture.operationName !== null
        ? (operationNameCounts.get(capture.operationName) ?? 0) / maxRecurrence
        : 0;
    // Field correlation carries the heaviest weight so a smaller facet-matching
    // operation outranks a larger decoy — size alone must not decide this.
    const score = fieldScore * 0.45 + sizeScore * 0.2 + phaseScore * 0.15 + recurrenceScore * 0.2;
    return { capture, score };
  });

  const winner = scored.reduce((best, candidate) =>
    candidate.score > best.score ? candidate : best
  );

  const endpointPath = (() => {
    try {
      return new URL(winner.capture.url).pathname;
    } catch {
      return firstEndpointPath(candidates);
    }
  })();

  return { capture: winner.capture, endpointPath };
}

export function firstEndpointPath(captures: Capture[]): string {
  const nonGetCaptures = captures.filter((c) => c.method !== "GET");
  for (const c of nonGetCaptures) {
    try {
      return new URL(c.url).pathname;
    } catch {
      // skip
    }
  }
  for (const c of captures) {
    try {
      return new URL(c.url).pathname;
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

interface ActionCapture {
  capture: Capture;
  index: number;
}

/**
 * Flow-declared regexes that isolate the real submission POSTs from same-origin
 * page chrome. `endpoint` matches the request URL; `body` matches the request
 * body (for ATSes that overload one endpoint by a body discriminator). Both are
 * null when the flow declares neither — in which case selection falls back to
 * the host/noise heuristic and no submit-pattern gate is applied.
 */
export interface SubmitPatterns {
  endpoint: string | null;
  body: string | null;
}

/**
 * Builds the compiled submit-pattern predicate. A flow-declared regex that
 * fails to compile is a broken flow (recon-browser validates it eagerly too),
 * so we let the `RegExp` constructor throw rather than silently reverting to
 * unfiltered selection, which would re-admit the page-chrome bloat this gate
 * exists to remove.
 */
function compileSubmitMatcher(patterns: SubmitPatterns | null): (capture: Capture) => boolean {
  if (patterns === null || (patterns.endpoint === null && patterns.body === null)) {
    return () => true;
  }
  const endpointRx = patterns.endpoint === null ? null : new RegExp(patterns.endpoint);
  const bodyRx = patterns.body === null ? null : new RegExp(patterns.body);
  return (capture: Capture): boolean => {
    if (endpointRx !== null && !endpointRx.test(capture.url)) return false;
    if (bodyRx !== null && !bodyRx.test(capture.requestPostData ?? "")) return false;
    return true;
  };
}

/**
 * Reads `submit-manifest.json` (written by recon-browser) and resolves it to the
 * authoritative submission action sequence. This is the deepest submit-selection
 * signal: recon-browser matched these captures against the flow's declared submit
 * patterns at run time, so generate emits exactly them instead of re-deriving the
 * submission from raw traffic. Returns null when no manifest exists (older runs,
 * `recon-http`-only) so the caller falls back to pattern/heuristic extraction.
 *
 * The manifest's `index` is the capture's sort-order position, and `captures`
 * arrives already `.sort()`ed by `readJsonDir`, so `captures[index]` is the same
 * capture recon-browser recorded — cross-checked on `url` as a guard against a
 * capture set that drifted between runs.
 */
export function resolveManifestActionSequence(
  runRoot: string,
  captures: Capture[]
): ActionCapture[] | null {
  const manifestPath = join(runRoot, "submit-manifest.json");
  let entries: { index: number; filename: string; url: string }[];
  try {
    entries = JSON.parse(readFileSync(manifestPath, "utf8")) as typeof entries;
  } catch {
    return null;
  }
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const resolved: ActionCapture[] = [];
  for (const entry of entries) {
    const capture = captures[entry.index];
    if (capture === undefined || capture.url !== entry.url) return null;
    resolved.push({ capture, index: entry.index });
  }
  return resolved;
}

/**
 * Extracts the ordered sequence of meaningful POSTs that represent the
 * transactional flow: non-noise 2xx POSTs, minus telemetry and error-reporting
 * sinks. Assets need no filter of their own — they arrive as GETs. Host is
 * NOT a filter criterion — a multi-step submission routinely bounces to a
 * different host mid-flow (an account-creation redirect, a tenant API
 * subdomain distinct from the landing page's host), so `isNoiseUrl` alone
 * decides what counts as site traffic vs. third-party noise.
 *
 * When the flow declares submit patterns, only POSTs matching them survive —
 * this isolates the submission from same-origin page chrome (bootstrap, chatbot,
 * JWT refresh, reference-lookup) that a browser fires incidentally. Absent
 * patterns preserve the noise heuristic exactly.
 *
 * Exported for tests: this predicate decides what a generated plugin will POST
 * at a live site, and it is the only gate between a browser's incidental
 * chatter and the emitted hot path.
 */
export function extractActionSequence(
  captures: Capture[],
  submitPatterns: SubmitPatterns | null = null
): ActionCapture[] {
  const matchesSubmit = compileSubmitMatcher(submitPatterns);

  return captures
    .map((capture, index) => ({ capture, index }))
    .filter(({ capture }) => {
      if (capture.method === "GET") return false;
      if (capture.status < 200 || capture.status >= 300) return false;
      if (isNoiseUrl(capture.url)) return false;
      if (!matchesSubmit(capture)) return false;
      return true;
    });
}

/**
 * GraphQL-aware analog of {@link extractActionSequence}: REST's URL/method
 * shape doesn't apply when every operation POSTs to the same endpoint, so
 * relevance here is decided by `operationName`/`query` instead. Keeps only
 * captures whose GraphQL document is a `mutation` — the write operations that
 * make up a transactional flow (`UpsertSavedApplication`, `SubmitForm`, ...)
 * — and drops `query` operations, which are read/bootstrap calls (e.g. a
 * page-load `ListForms`) that carry no state-threading value and are exactly
 * what let a chronologically-first fallback pick an unrelated query. Host is
 * NOT a filter criterion, matching {@link extractActionSequence}.
 *
 * Exported for tests: this predicate decides what a generated GraphQL plugin
 * will send at a live site.
 */
export function extractGraphQLActionSequence(
  captures: Capture[],
  submitPatterns: SubmitPatterns | null = null
): ActionCapture[] {
  const matchesSubmit = compileSubmitMatcher(submitPatterns);

  return captures
    .map((capture, index) => ({ capture, index }))
    .filter(({ capture }) => {
      if (capture.operationName === null) return false;
      if (capture.status < 200 || capture.status >= 300) return false;
      if (isNoiseUrl(capture.url)) return false;
      if (!matchesSubmit(capture)) return false;
      return capture.query !== null && /^\s*mutation\b/.test(capture.query);
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
   * body JSON leaf (e.g. listings-fixture's `Set-Cookie: __pa=<jwt>` token mint).
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
 * Parses a captured request body as JSON and returns its string leaf *values*
 * (object keys are excluded — a key is never a JSON value). Returns null when
 * the body is absent or not JSON (e.g. multipart raw bytes), so callers can
 * fall back to whole-body substring matching. This lets the produces-filter
 * match state values against JSON values only, so a response string that
 * appears downstream solely in a JSON *key* position is not mistaken for a
 * reused value — while a value legitimately embedded inside a longer value
 * still matches via substring.
 */
function jsonBodyLeafValues(requestPostData: string | null | undefined): string[] | null {
  if (typeof requestPostData !== "string" || requestPostData.length === 0) return null;
  const parsed = ((): unknown => {
    try {
      return JSON.parse(requestPostData);
    } catch {
      return undefined;
    }
  })();
  if (parsed === undefined) return null;
  const values: string[] = [];
  for (const { value } of walkStringLeaves(parsed)) values.push(value);
  return values;
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
 * exact form they ship (e.g. a `ResponseValidationErrors` key).
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
 * Site-agnostic: one ATS may use `Message`/`Sections.ResponseValidationErrors`
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
 * Map from form-schema field-id UUIDs to PascalCase payload field names. Used
 * by emitMultiStepExecuteHttp to substitute the submitted-value literals with
 * caller payload references. Empty when the recon doesn't include a form
 * schema (no-op for those sites).
 */
type FieldNameMap = Map<string, string>;

/**
 * Per-option-using field: an ordered list of {semanticValue, optionId}
 * pairs derived from the form schema's options array. The generator emits
 * each as an OPT_<Name> constant + z.enum payload field; the body emit
 * pass rewrites the submitted option-id slots to `${OPT_X[payload.X]}`.
 *
 * Only populated for fields whose options all have a non-empty label. Options
 * without a semantic label are skipped — the field's option ids stay baked.
 */
interface FieldOptionsMapping {
  semanticName: string;
  options: Array<{ value: string; optionId: string }>;
}
type FieldOptionsMap = Map<string, FieldOptionsMapping>;

/**
 * Converts a machine code like "contact.first.name" or "address.country.subdivision"
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
 * Converts a free-form field label like "Reference #1 First Name" or "Email" to
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
 * for arrays whose objects look like form fields (a UUID-shaped field-id key
 * plus at least one of the schema's name keys). Builds field-id → PascalCase
 * name map.
 *
 * Site-agnostic: identifies form-schema captures by structural fingerprint
 * against the consumer-supplied keys, not by URL or site name. Any ATS exposing
 * a matching schema would match.
 *
 * Exported for unit testing — lets tests prove the rewiring: the same field is
 * recovered whether the supplied keys are one vendor's names or a differing
 * vendor's, and that a null schema recovers nothing.
 */
export function detectFormSchemaFieldNames(
  captures: Capture[],
  formSchema: ReconFormSchema | null
): {
  fieldNameMap: FieldNameMap;
  fieldOptionsMap: FieldOptionsMap;
  allSchemaUuids: Set<string>;
} {
  const fieldNameMap: FieldNameMap = new Map();
  const fieldOptionsMap: FieldOptionsMap = new Map();
  const allSchemaUuids = new Set<string>();
  // No form-schema declared → recover nothing. The engine carries no vendor's
  // wire keys, so there is nothing to fingerprint ATS responses against.
  if (formSchema === null) return { fieldNameMap, fieldOptionsMap, allSchemaUuids };
  for (const capture of captures) {
    walkForSectionFieldsArrays(capture.responseBody, fieldNameMap, fieldOptionsMap, formSchema);
    walkForSchemaUuids(capture.responseBody, allSchemaUuids, formSchema);
  }
  return { fieldNameMap, fieldOptionsMap, allSchemaUuids };
}

/**
 * Walks a response body collecting UUID-shaped strings under the schema's
 * field-id key, or under the option-id key of an entry in a sibling
 * field-options array. These are stable schema anchors that must be shielded
 * from state-threading even when detectFormSchemaFieldNames emits no
 * payload-mappable name for the field (e.g. when the field name is too long for
 * our naming heuristic).
 *
 * The wire keys come from the consumer-supplied {@link ReconFormSchema}, so a
 * vendor declares its own keys with `--form-schema` rather than the engine
 * hardcoding any — the inversion issue #57 asked for.
 */
function walkForSchemaUuids(value: unknown, out: Set<string>, formSchema: ReconFormSchema): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walkForSchemaUuids(item, out, formSchema);
    return;
  }
  const obj = value as Record<string, unknown>;
  const fieldIdRaw = obj[formSchema.fieldIdKey];
  if (typeof fieldIdRaw === "string" && UUID_REGEX.test(fieldIdRaw)) {
    out.add(fieldIdRaw);
  }
  const optionsRaw = obj[formSchema.fieldOptionsKey];
  if (Array.isArray(optionsRaw)) {
    for (const opt of optionsRaw) {
      if (opt !== null && typeof opt === "object") {
        const optId = (opt as Record<string, unknown>)[formSchema.optionIdKey];
        if (typeof optId === "string" && UUID_REGEX.test(optId)) out.add(optId);
      }
    }
  }
  // Recurse into nested objects/arrays so nested form fields get walked too.
  for (const v of Object.values(obj)) walkForSchemaUuids(v, out, formSchema);
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
 * GET capture (in recon order) whose response body contains a form-fields-
 * shaped array (per the supplied schema keys). Sites without such a capture get
 * `null` and Phase B/C/D become no-ops.
 *
 * Site-agnostic: identifies the fetch by structural fingerprint of the
 * response body, not by URL or site name.
 */
function detectFormSchemaFetchCapture(
  captures: Capture[],
  baseUrl: string,
  formSchema: ReconFormSchema
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
    if (telemetryUrlPatterns().some((p) => capture.url.includes(p))) continue;
    if (responseContainsSectionFields(capture.responseBody, formSchema)) {
      return { capture, index: i };
    }
  }
  return null;
}

function responseContainsSectionFields(value: unknown, formSchema: ReconFormSchema): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    if (looksLikeSectionFieldsArray(value, formSchema)) return true;
    for (const item of value) {
      if (responseContainsSectionFields(item, formSchema)) return true;
    }
    return false;
  }
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (responseContainsSectionFields(v, formSchema)) return true;
  }
  return false;
}

function walkForSectionFieldsArrays(
  value: unknown,
  fieldNameMap: FieldNameMap,
  fieldOptionsMap: FieldOptionsMap,
  formSchema: ReconFormSchema
): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    if (looksLikeSectionFieldsArray(value, formSchema)) {
      assignFieldNamesFromArray(
        value as Array<Record<string, unknown>>,
        fieldNameMap,
        fieldOptionsMap,
        formSchema
      );
    }
    for (const item of value)
      walkForSectionFieldsArrays(item, fieldNameMap, fieldOptionsMap, formSchema);
    return;
  }
  for (const v of Object.values(value as Record<string, unknown>)) {
    walkForSectionFieldsArrays(v, fieldNameMap, fieldOptionsMap, formSchema);
  }
}

/**
 * Structural fingerprint: array of objects, at least half of which have a
 * UUID-shaped field-id AND at least one of the schema's field-name keys.
 */
function looksLikeSectionFieldsArray(arr: unknown[], formSchema: ReconFormSchema): boolean {
  if (arr.length === 0) return false;
  let matches = 0;
  for (const item of arr) {
    if (item === null || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const fieldIdRaw = obj[formSchema.fieldIdKey];
    if (typeof fieldIdRaw !== "string") continue;
    if (!UUID_REGEX.test(fieldIdRaw)) continue;
    if (formSchema.fieldNameKeys.some((key) => typeof obj[key] === "string")) {
      matches++;
    }
  }
  return matches >= Math.max(1, Math.floor(arr.length * 0.5));
}

function assignFieldNamesFromArray(
  arr: Array<Record<string, unknown>>,
  fieldNameMap: FieldNameMap,
  fieldOptionsMap: FieldOptionsMap,
  formSchema: ReconFormSchema
): void {
  let currentPrefix: string | null = null;
  const usedNames = new Set<string>([...fieldNameMap.values()]);
  // First field-name key is the machine code (preferred, PascalCased directly);
  // any later key is a human label (subject to the section-heading heuristic).
  // With one key both branches collapse to the label path.
  const [codeKey, ...labelKeys] = formSchema.fieldNameKeys;
  const labelKey = labelKeys[0];
  for (const obj of arr) {
    const fieldId = obj[formSchema.fieldIdKey];
    if (typeof fieldId !== "string") continue;

    const sourceCode = codeKey !== undefined && labelKey !== undefined ? obj[codeKey] : undefined;
    const name = labelKey !== undefined ? obj[labelKey] : obj[codeKey ?? ""];

    let semantic: string | null = null;
    if (typeof sourceCode === "string" && sourceCode.trim().length > 0) {
      semantic = sourceCodeToPascalCase(sourceCode);
      currentPrefix = null;
    } else if (typeof name === "string" && name.trim().length > 0 && name.length < 250) {
      const hasNoSourceCode = typeof sourceCode !== "string" || sourceCode.trim().length === 0;
      // Section-heading heuristic: short label, no machine code, MOSTLY
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

      // Capture the field's options when present and ALL options have non-empty
      // semantic labels. Options with an empty label are skipped — with no
      // semantic value we can't generate a meaningful enum, so we leave the
      // field's option-id baked.
      const optionsRaw = obj[formSchema.fieldOptionsKey];
      if (Array.isArray(optionsRaw) && optionsRaw.length > 0) {
        const options: Array<{ value: string; optionId: string }> = [];
        let allSemantic = true;
        for (const optRaw of optionsRaw) {
          if (optRaw === null || typeof optRaw !== "object") {
            allSemantic = false;
            break;
          }
          const opt = optRaw as Record<string, unknown>;
          const optId = opt[formSchema.optionIdKey];
          const optValue = opt[formSchema.optionValueKey];
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
 * Substitutes the submitted-value literals with payload accessors based on the
 * field-name map from the form schema. Operates on the body string before
 * state interpolation so already-substituted state values (e.g. ${firstName})
 * are preserved.
 *
 * Closed-set substring matching: both the field-id and the submitted value come
 * from the generator's own input (recon).
 */
function applyFormSchemaSubstitutions(
  rawBody: string,
  fieldNameMap: FieldNameMap,
  outDiscoveredFields: Set<string>,
  formSchema: ReconFormSchema
): string {
  if (fieldNameMap.size === 0) return rawBody;
  let result = rawBody;
  const valueMarker = `"${formSchema.responseValueKey}":"`;
  for (const [fieldId, semanticName] of fieldNameMap) {
    const fieldIdMarker = `"${formSchema.fieldIdKey}":"${fieldId}"`;
    let cursor = 0;
    while (true) {
      const idx = result.indexOf(fieldIdMarker, cursor);
      if (idx === -1) break;
      const objEnd = result.indexOf("}", idx);
      if (objEnd === -1) break;
      const segment = result.slice(idx, objEnd);
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
 * Substitutes submitted option-id literals with payload-driven enum lookups.
 * Operates on the body string before state interpolation. For each field with a
 * captured FieldOptionsMapping, find the schema's field-id marker and rewrite
 * the matching option-id value to `${OPT_<Name>[payload.<Name>]}`.
 *
 * Order-insensitive: matches the option-id marker anywhere within the same
 * JSON object as the field-id marker (which is between it and the closing `}`).
 * Closed-set substring matching: both marker values come from the generator's
 * own input.
 */
function applyFormSchemaOptionIdSubstitutions(
  rawBody: string,
  fieldOptionsMap: FieldOptionsMap,
  outDiscoveredOptionFields: Set<string>,
  formSchema: ReconFormSchema
): string {
  if (fieldOptionsMap.size === 0) return rawBody;
  let result = rawBody;
  const optionIdMarker = `"${formSchema.responseOptionIdKey}":"`;
  for (const [fieldId, mapping] of fieldOptionsMap) {
    const fieldIdMarker = `"${formSchema.fieldIdKey}":"${fieldId}"`;
    let cursor = 0;
    while (true) {
      const idx = result.indexOf(fieldIdMarker, cursor);
      if (idx === -1) break;
      const objEnd = result.indexOf("}", idx);
      if (objEnd === -1) break;
      const segment = result.slice(idx, objEnd);
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
 * For fields whose options have NO semantic labels (the schema's option-label
 * value is empty), T3's OPT_* enum mapping can't be emitted. Instead,
 * parameterize the submitted option-id slot as a caller-supplied
 * `<Name>OptionId` payload field with the recon-observed UUID documented in a
 * TSDoc comment.
 *
 * Operates on the same field-id-anchored search as
 * applyFormSchemaOptionIdSubstitutions, but only fires when the field is in
 * fieldNameMap (has a semantic name) AND NOT in fieldOptionsMap (the structured
 * enum substitution didn't fire). Site-agnostic.
 */
function applyRawOptionIdPayloadSubstitutions(
  rawBody: string,
  fieldNameMap: FieldNameMap,
  fieldOptionsMap: FieldOptionsMap,
  outDiscoveredRawOptionFields: Map<string, string>,
  formSchema: ReconFormSchema
): string {
  if (fieldNameMap.size === 0) return rawBody;
  let result = rawBody;
  const optionIdMarker = `"${formSchema.responseOptionIdKey}":"`;
  for (const [fieldId, fieldName] of fieldNameMap) {
    if (fieldOptionsMap.has(fieldId)) continue; // T3's OPT_* already handles this.
    const fieldIdMarker = `"${formSchema.fieldIdKey}":"${fieldId}"`;
    let cursor = 0;
    while (true) {
      const idx = result.indexOf(fieldIdMarker, cursor);
      if (idx === -1) break;
      const objEnd = result.indexOf("}", idx);
      if (objEnd === -1) break;
      const segment = result.slice(idx, objEnd);
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

/** A resolved dropdown answer: the wire KEY the ATS submits under, the option
 * CODE it expects, the human LABEL the flow step named, and the full label set
 * (used to build the caller-facing z.enum). Anchored on the wire key so the
 * body-slot rewrite is a closed-set JSON-key match. */
interface SelectOptionResolution {
  wireKey: string;
  semanticName: string;
  code: string;
  label: string;
  /** Every caller-selectable label paired with its wire code, so OPT_<Name>
   * maps the full option set (not just the recon-answered choice). */
  options: Array<{ label: string; code: string }>;
}

/** i18n label placeholders (e.g. `{{apply.option.label.gender.a}}`) are not
 * human-facing answers and can never be matched against a flow step's quoted
 * label, so a schema whose labels are all templated yields no usable
 * label→code mapping. */
function isI18nLabel(label: string): boolean {
  return label.includes("{{");
}

/**
 * Indexes the JSON-Schema `enum`/`enumNames` PARALLEL-ARRAY convention across
 * every response body: an object carrying a string `name` plus equal-length
 * `enum` (option codes) and `enumNames` (option labels) declares one dropdown's
 * label→code mapping, disambiguated per-question by `name`. This is the PRIMARY
 * label→code source for ATS demographic/eligibility dropdowns whose submitted
 * value is an opaque code, not the label.
 *
 * The same `name` can appear in several captures with progressively fuller
 * option lists (a later page reveals the "decline to answer" choice), so the
 * entry with the MOST non-i18n labels wins rather than first-seen — the flow's
 * answer might be the choice only the fuller list carries.
 *
 * Site-agnostic: `enum`/`enumNames` are generic JSON-Schema keys; the field
 * identities are discovered from the response, never hardcoded.
 */
export function indexEnumEnumNamesSchemas(
  captures: Capture[]
): Map<string, { codes: string[]; labels: string[] }> {
  const out = new Map<string, { codes: string[]; labels: string[] }>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const obj = value as Record<string, unknown>;
    const name = obj.name;
    const en = obj.enum;
    const nm = obj.enumNames;
    if (
      typeof name === "string" &&
      Array.isArray(en) &&
      Array.isArray(nm) &&
      en.length === nm.length &&
      en.length > 0 &&
      en.every((c) => typeof c === "string") &&
      nm.every((l) => typeof l === "string")
    ) {
      const codes = en as string[];
      const labels = nm as string[];
      const usable = labels.filter((l) => !isI18nLabel(l)).length;
      const prior = out.get(name);
      const priorUsable = prior ? prior.labels.filter((l) => !isI18nLabel(l)).length : -1;
      if (usable > priorUsable) out.set(name, { codes, labels });
    }
    for (const v of Object.values(obj)) walk(v);
  };
  for (const capture of captures) walk(capture.responseBody);
  return out;
}

/**
 * Indexes the `{label,value}`-shaped option-object convention: arrays of
 * objects each carrying both a `label` and a `value` string (state/country
 * pickers ship these). Builds a GLOBAL label→code map used as the fallback
 * source for dropdowns whose flow step carries no `id=` hint (so the
 * enum/enumNames index can't be keyed) — the answer label is looked up
 * directly. First non-i18n binding wins on a duplicate label.
 *
 * Site-agnostic: `label`/`value` are generic option-object keys; no field name
 * is assumed.
 */
export function indexLabelValueOptionCodes(captures: Capture[]): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== null && typeof item === "object" && !Array.isArray(item)) {
          const r = item as Record<string, unknown>;
          const label = r.label;
          const code = r.value;
          if (
            typeof label === "string" &&
            typeof code === "string" &&
            label.length > 0 &&
            code.length > 0 &&
            !isI18nLabel(label) &&
            !out.has(label)
          ) {
            out.set(label, code);
          }
        }
        walk(item);
      }
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const v of Object.values(value as Record<string, unknown>)) walk(v);
  };
  for (const capture of captures) walk(capture.responseBody);
  return out;
}

/**
 * Reconciles each flow SELECT step to a submitted option CODE so the body-slot
 * literal (`"applyHealthCareExclusion":"5395"`) can be rewritten to a
 * caller-driven `${OPT_<Name>[payload.<Name>]}` lookup. Real ATS bodies carry
 * codes, not labels; the flow carries labels — this bridges them via the two
 * generic label→code conventions ({@link indexEnumEnumNamesSchemas} primary,
 * {@link indexLabelValueOptionCodes} fallback).
 *
 * The wire KEY is discovered from the step's `id=<field>` hint when present
 * (the enum/enumNames schema is keyed by that same field name); steps without
 * an `id=` (state/country) fall back to the vocabulary-resolved persona field
 * lowercased, matched against the `{label,value}` map by label. A dropdown
 * whose labels are all i18n placeholders (e.g. gender) yields no enum and is
 * reported separately for the raw-code channel.
 *
 * Returns structured resolutions plus the set of i18n-only wire keys (raw-code
 * fallbacks). Site-agnostic: field identities come from the flow's own `id=`
 * hints and the consumer vocabulary, never a hardcoded key.
 */
export function buildSelectOptionResolutions(
  flowSteps: FlowStepInput[],
  captures: Capture[],
  vocabulary: ReconVocabulary,
  env: NodeJS.ProcessEnv
): {
  resolutions: SelectOptionResolution[];
  rawCodeFields: Map<string, { wireKey: string; code: string }>;
} {
  const enumSchemas = indexEnumEnumNamesSchemas(captures);
  const labelValue = indexLabelValueOptionCodes(captures);
  const resolutions: SelectOptionResolution[] = [];
  const rawCodeFields = new Map<string, { wireKey: string; code: string }>();
  const seenWireKeys = new Set<string>();
  for (const step of flowSteps) {
    const instruction = typeof step === "string" ? step : step.step;
    if (!/^\s*(select|choose|pick)\b/i.test(instruction) && !/\bselect\b/i.test(instruction)) {
      continue;
    }
    const idMatch = /id=(\w+)/.exec(instruction);
    // A Select step names the ANSWER first, then the question — so the answer is
    // the FIRST quoted token (apostrophe-aware). extractStepPersonaValue only
    // returns first-quote when the sentence STARTS with select/choose/pick; a
    // dropdown step phrased "On the X step, select 'No' in the '…?' dropdown"
    // starts with "On", so read the first quote directly here for id= steps.
    const firstQuoteLabel = ((): string | null => {
      const cleaned = instruction.replace(/(\w)'s\b/g, "$1s");
      const m = /'([^']*)'/.exec(cleaned);
      return m && m[1]!.length > 0 ? m[1]! : null;
    })();
    const label = idMatch ? firstQuoteLabel : extractStepPersonaValue(instruction, env);
    if (label === null) continue;
    // Primary: an id= hint names the wire key AND the enum/enumNames schema key.
    if (idMatch) {
      const wireKey = idMatch[1]!;
      if (seenWireKeys.has(wireKey)) continue;
      const schema = enumSchemas.get(wireKey);
      if (!schema) continue;
      const semanticName = fieldNameToPascalCase(wireKey, null);
      if (semanticName === null) continue;
      const idx = schema.labels.indexOf(label);
      const usableOptions = schema.labels
        .map((l, i) => ({ label: l, code: schema.codes[i]! }))
        .filter((o) => !isI18nLabel(o.label));
      if (idx >= 0 && !isI18nLabel(schema.labels[idx]!)) {
        resolutions.push({
          wireKey,
          semanticName,
          code: schema.codes[idx]!,
          label,
          options: usableOptions,
        });
        seenWireKeys.add(wireKey);
        continue;
      }
      // Label is i18n-only (or the answer maps to a templated label): the field
      // still must not stay frozen — surface the recon-observed code so the raw
      // channel emits a caller-supplied default.
      if (usableOptions.length === 0 && schema.codes.length > 0) {
        const fallbackIdx = idx >= 0 ? idx : schema.codes.length - 1;
        rawCodeFields.set(semanticName, { wireKey, code: schema.codes[fallbackIdx]! });
        seenWireKeys.add(wireKey);
      }
      continue;
    }
    // Fallback: no id= — resolve the wire key from the vocabulary persona field
    // (lowercased) and the code from the global {label,value} map by label.
    const field = resolveStepPayloadField(
      instruction,
      typeof step === "string" ? undefined : step.payloadField,
      typeof step === "string" ? undefined : step.payloadFieldNone,
      vocabulary
    );
    if (field === null) continue;
    const code = labelValue.get(label);
    if (code === undefined) continue;
    const wireKey = field.toLowerCase();
    if (seenWireKeys.has(wireKey)) continue;
    const semanticName = fieldNameToPascalCase(wireKey, null);
    if (semanticName === null) continue;
    // The {label,value} map only reliably yields the one answered label→code
    // pair here; emit a single-choice enum so the field still binds (the caller
    // can widen it). Co-located labels aren't safely attributable to this field.
    resolutions.push({ wireKey, semanticName, code, label, options: [{ label, code }] });
    seenWireKeys.add(wireKey);
  }
  return { resolutions, rawCodeFields };
}

/**
 * Rewrites plain-JSON dropdown body slots (`"<wireKey>":"<code>"`) to a
 * caller-driven `${OPT_<Name>[payload.<Name>]}` lookup, anchored on the wire
 * KEY rather than the UUID field-id marker
 * {@link applyFormSchemaOptionIdSubstitutions} uses. This is the plain-JSON
 * ATS case where the submitted body is a flat `{ "field": "code" }` map with no
 * schema envelope, so the key/value pair — both drawn from recon input — is the
 * only closed-set anchor available.
 *
 * Records each rewritten field's semanticName into `outDiscoveredOptionFields`
 * so emitContractTs lights up its OPT_<Name> const + z.enum payload entry, and
 * mutates `fieldOptionsMap` so that emit finds the option mapping. Closed-set:
 * both the key and the code come from the recon-derived resolutions.
 */
function applyGenericOptionCodeSubstitutions(
  rawBody: string,
  resolutions: SelectOptionResolution[],
  fieldOptionsMap: FieldOptionsMap,
  outDiscoveredOptionFields: Set<string>
): string {
  if (resolutions.length === 0) return rawBody;
  let result = rawBody;
  for (const res of resolutions) {
    const slot = `"${res.wireKey}":"${res.code}"`;
    if (!result.includes(slot)) continue;
    const replacement = `"${res.wireKey}":"$${"{"}OPT_${res.semanticName}[payload.${res.semanticName}]${"}"}"`;
    result = result.split(slot).join(replacement);
    // Mutate the option map so emitContractTs emits OPT_<Name> + the z.enum.
    if (!fieldOptionsMap.has(res.wireKey)) {
      fieldOptionsMap.set(res.wireKey, {
        semanticName: res.semanticName,
        options: res.options.map((o) => ({ value: o.label, optionId: o.code })),
      });
    }
    outDiscoveredOptionFields.add(res.semanticName);
  }
  return result;
}

/**
 * Rewrites the body slot of an i18n-only dropdown (one whose labels are all
 * templated placeholders, so no OPT_<Name> enum is possible) from its frozen
 * recon code to a caller-supplied `${payload.<Name>Code}`. This is the
 * plain-JSON, wire-key-anchored twin of {@link applyRawOptionIdPayloadSubstitutions}
 * (which is UUID/form-schema anchored) — without it a field like gender would
 * submit the recon persona's frozen choice for every caller.
 */
function applyGenericRawCodeSubstitutions(
  rawBody: string,
  rawCodeFields: Map<string, { wireKey: string; code: string }>
): string {
  if (rawCodeFields.size === 0) return rawBody;
  let result = rawBody;
  for (const [semanticName, { wireKey, code }] of rawCodeFields) {
    const slot = `"${wireKey}":"${code}"`;
    if (!result.includes(slot)) continue;
    const replacement = `"${wireKey}":"$${"{"}payload.${semanticName}Code${"}"}"`;
    result = result.split(slot).join(replacement);
  }
  return result;
}

/** Counts an object's DIRECT primitive-valued children (string/number/boolean/
 * null). The form envelope is the object with the most of these — its scalar
 * children are the fields every other binding pass individually parameterizes,
 * so it must never be swallowed wholesale. */
function directPrimitiveChildCount(obj: Record<string, unknown>): number {
  let n = 0;
  for (const v of Object.values(obj)) {
    if (v === null || (typeof v !== "object" && typeof v !== "function")) n++;
  }
  return n;
}

/**
 * Locates the FORM ENVELOPE inside a submit body — the nested object that
 * actually holds the scalar form fields (which every other pass binds one by
 * one) — by descending through wrapper objects and picking the object with the
 * most direct primitive children. Returns its dotted path from the body root
 * (empty when the root itself is the envelope). Site-agnostic: no key names are
 * assumed; the envelope is found by shape.
 */
function locateFormEnvelopePath(parsedBody: unknown): string[] {
  const candidates: Array<{ path: string[]; primitives: number }> = [];
  const visit = (value: unknown, path: string[]): void => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return;
    const obj = value as Record<string, unknown>;
    candidates.push({ path, primitives: directPrimitiveChildCount(obj) });
    for (const [k, v] of Object.entries(obj)) visit(v, [...path, k]);
  };
  visit(parsedBody, []);
  if (candidates.length === 0) return [];
  const maxP = Math.max(...candidates.map((c) => c.primitives));
  // The analytics blob (`eventData`) parallels the form, so the object with the
  // MOST primitives can be a deep descendant of the true envelope. Pick the
  // SHALLOWEST primitive-rich object (≥ half the max) instead — that is the
  // form envelope itself, whose analytics copy sits below it. Tie-break on a
  // higher primitive count. Threshold is relative, not a magic key name.
  const rich = candidates.filter((c) => c.primitives >= Math.max(1, maxP / 2));
  // No object carries a scalar field (maxP === 0): the body root is the only
  // sensible envelope — operate at the top level.
  if (rich.length === 0) return [];
  rich.sort((a, b) => a.path.length - b.path.length || b.primitives - a.primitives);
  return rich[0]!.path;
}

/**
 * Parameterizes whole nested caller-supplied structures sitting BESIDE the
 * scalar form fields — the array-valued work/education history
 * (`experienceData`/`educationData`/`dqData`) and the opaque `eventData`
 * analytics object — replacing each `"key":<json>` span with
 * `"key":${JSON.stringify(payload.<key>)}` and recording the key's inferred Zod
 * schema so emitContractTs adds it to the payload contract.
 *
 * These blocks are caller data the recon merely captured a frozen sample of;
 * freezing them would submit one applicant's history for every caller. Crucially
 * the FORM ENVELOPE object itself (the one carrying firstName/state/… that the
 * persona and dropdown passes bind field-by-field) is NEVER swallowed — that
 * would collapse the whole form to one opaque `${JSON.stringify(payload.formData)}`
 * and defeat every other binding. {@link locateFormEnvelopePath} finds it by
 * shape; only its non-scalar SIBLING children are parameterized. A
 * brace/bracket-depth scanner finds the exact JSON span (the captured body is
 * well-formed).
 *
 * NOTE on `eventData`: it becomes an opaque `${JSON.stringify(payload.eventData)}`
 * passthrough. Its nested volatiles (apTxnId, per-step timestamps) therefore
 * become the CALLER's responsibility to mint fresh — acceptable because the
 * whole blob is caller-supplied; the generator can't reach inside a value it
 * has delegated wholesale.
 *
 * Site-agnostic: operates only on the recon body's own shape.
 */
function applyStructuredValuePayloadSubstitutions(
  template: string,
  parsedBody: unknown,
  outStructuredKeys: Map<string, string>
): string {
  if (parsedBody === null || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
    return template;
  }
  // Resolve the envelope object whose non-scalar children are caller structures.
  const envelopePath = locateFormEnvelopePath(parsedBody);
  let envelope: unknown = parsedBody;
  for (const seg of envelopePath) {
    if (envelope !== null && typeof envelope === "object" && !Array.isArray(envelope)) {
      envelope = (envelope as Record<string, unknown>)[seg];
    }
  }
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
    return template;
  }
  let result = template;
  for (const [key, value] of Object.entries(envelope as Record<string, unknown>)) {
    const isNonEmptyArray = Array.isArray(value) && value.length > 0;
    const isNestedObject =
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value as Record<string, unknown>).length > 0;
    if (!isNonEmptyArray && !isNestedObject) continue;
    const keyMarker = `"${key}":`;
    const markerIdx = result.indexOf(keyMarker);
    if (markerIdx === -1) continue;
    const spanStart = markerIdx + keyMarker.length;
    const open = result[spanStart];
    if (open !== "[" && open !== "{") continue;
    const close = open === "[" ? "]" : "}";
    let depth = 0;
    let inString = false;
    let escaped = false;
    let spanEnd = -1;
    for (let i = spanStart; i < result.length; i++) {
      const ch = result[i]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          spanEnd = i + 1;
          break;
        }
      }
    }
    if (spanEnd === -1) continue;
    const replacement = `$${"{"}JSON.stringify(payload.${key})${"}"}`;
    result = result.slice(0, spanStart) + replacement + result.slice(spanEnd);
    if (!outStructuredKeys.has(key)) {
      outStructuredKeys.set(key, inferZodSchema(value));
    }
  }
  return result;
}

/** Maximum length to guard against indexing massive blobs (HTML fragments,
 * embedded base64 images, etc.) that aren't candidates for state threading. */
const MAX_STATE_VALUE_LENGTH = 256;

/** Maximum length for `Set-Cookie`-origin values, distinct from
 * `MAX_STATE_VALUE_LENGTH`. Auth tokens (JWTs) legitimately exceed the
 * body-blob cap — a 272-char session cookie is normal, not a massive blob —
 * so cookie origins get their own, more permissive ceiling. Still bounded so
 * a pathological cookie can't blow up the index. */
const MAX_COOKIE_STATE_VALUE_LENGTH = 4096;

/** Canonical "uninitialized" sentinel values that some REST APIs return as
 * placeholders before a downstream call populates the real identifier. An ATS
 * whose `/user/create` returns these for CandidateId/ApplicationId/
 * ApplyProcessId, then yields the real values on `/user/start`, is the case that
 * motivated this: indexing the placeholder would lock the generated plugin's
 * `${candidateId}` binding to the all-zero UUID — every downstream call would
 * then 404 with "candidate does not exist". Closed set, literal-string match —
 * never expand to pattern-based detection (would trip the no-regex-on-open-sets
 * rule). */
const PLACEHOLDER_STATE_VALUES = new Set(["00000000-0000-0000-0000-000000000000"]);

/**
 * Splits a raw `Set-Cookie` response-header string into `name`/`value` pairs.
 * Captures store `responseHeaders` as a flat `Record<string, string>`
 * (see recon-shared.ts's `Capture`), so multiple `Set-Cookie` headers from the
 * same response are folded by the recon browser's CDP session into one
 * newline-delimited string — each line is one cookie's `name=value; attrs...`.
 * This walks every newline-delimited line and recovers the name/value pair
 * from before that line's first `;`, skipping any line with no `=`.
 */
/** Exported for unit testing — lets tests exercise the newline-fold parsing
 * directly against synthetic multi-cookie strings. */
export function* walkSetCookiePairs(
  rawSetCookie: string
): Generator<{ name: string; value: string }> {
  for (const line of rawSetCookie.split("\n")) {
    const pair = line.split(";", 1)[0] ?? "";
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (name && value) yield { name, value };
  }
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
 * later call's `Cookie` header via `compileActionSteps`. Cookie-origin values
 * are capped by `MAX_COOKIE_STATE_VALUE_LENGTH`, not `MAX_STATE_VALUE_LENGTH`
 * — session JWTs routinely exceed the body-blob cap.
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
    // token-mint call like listings-fixture's `authz/private` returns `{}` and
    // carries its whole payload in `Set-Cookie`.
    const rawSetCookie = Object.entries(c.responseHeaders).find(
      ([k]) => k.toLowerCase() === "set-cookie"
    )?.[1];
    if (rawSetCookie !== undefined) {
      for (const { name, value } of walkSetCookiePairs(rawSetCookie)) {
        if (value.length < MIN_STATE_VALUE_LENGTH) continue;
        if (value.length > MAX_COOKIE_STATE_VALUE_LENGTH) continue;
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
      // Schema-identifier UUIDs (the field-id and option-id anchors) are stable
      // anchors that T2/T3 substitution depends on remaining literal in body
      // templates.
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
 * Identifier segments use dot access; numeric / non-identifier segments use
 * JSON-quoted bracket access. A trailing `!` is emitted on bracket segments ONLY
 * when `assertNonNull` is set — the two call sites differ:
 *   - Payload accessors (`payload…`) target the real Zod-inferred payload type,
 *     where an array/index segment types as `T | undefined` under
 *     `noUncheckedIndexedAccess`; an intermediate index followed by more path
 *     fails to compile without the `!`, so it is required there.
 *   - Produce extractions (`(rN as <assertionType>)…`) target the object-literal
 *     type `pathToAssertionType` builds from known string-literal keys, which
 *     `noUncheckedIndexedAccess` does NOT widen — so the `!` is unnecessary AND
 *     is a Biome `noNonNullAssertion` error. That site passes `assertNonNull:
 *     false`.
 */
function pathToAccessor(
  path: string[],
  opts: { assertNonNull: boolean } = { assertNonNull: true }
): string {
  return path
    .map((p) =>
      isValidJsIdentifier(p) ? `.${p}` : `[${JSON.stringify(p)}]${opts.assertNonNull ? "!" : ""}`
    )
    .join("");
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
    const bodyLeafValues = jsonBodyLeafValues(capture.requestPostData);
    for (const sv of stateIndex.values()) {
      if (capture.url.includes(sv.value)) {
        usedValues.add(sv.value);
        continue;
      }
      // Body consumption is matched against JSON *values* only, never keys: a
      // state value is a real cross-step dependency when a later request
      // re-sends it inside a JSON value — either standalone or embedded in a
      // composite value (e.g. a jobId reused inside a longer jobSeqNo). A
      // match that lands on a JSON *key* is not reuse: binding then splicing it
      // would emit a variable into a key position and produce uncompilable
      // `"${var}":…` / `${${var}}` (e.g. a response echoing field NAMES like
      // `tokens:["firstName","lastName"]` — those strings appear downstream
      // only as keys, never within any value). Object keys are never JSON
      // string leaves, so testing against leaf values alone excludes them while
      // preserving substring-in-value reuse. Non-JSON bodies (multipart raw
      // bytes) keep whole-body substring matching.
      if (bodyLeafValues === null) {
        if (capture.requestPostData?.includes(sv.value)) usedValues.add(sv.value);
      } else if (bodyLeafValues.some((leaf) => leaf.includes(sv.value))) {
        usedValues.add(sv.value);
      }
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
        produces.push({ kind: "body", name, path });
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
 * listings-fixture's `Set-Cookie: __pa=<jwt>` mint to the stateful call that 401s
 * without it. Deduped by `targetHeader.toLowerCase()` + `cookieName` (HTTP
 * header names are case-insensitive, and compileActionSteps derives
 * `targetHeader` verbatim from observed request-header casing, so the same
 * logical target can show up as e.g. `Cookie` on one step and `cookie` on
 * another): the `Cookie` request header carries many cookies by design, so
 * every distinct cookie-origin produce targeting it must survive (the
 * runtime accumulates them into one `Cookie` header per binding — see
 * http-client.ts); only a produce that re-mints the SAME cookie on a later
 * step collapses to its earliest occurrence. Non-cookie targets (e.g.
 * `X-Conversation-Id`) still keep first-wins, since `HttpResponseBinding` is
 * one binding per target header there and two steps producing the same
 * non-cookie target (even under differing casing) would otherwise race with
 * no defined winner.
 *
 * Exported for unit testing (as `walkSetCookiePairs` is) — lets tests exercise
 * the produce → bind collection step directly against synthetic ActionStep
 * sequences.
 */
export function collectHeaderBindings(actionSteps: ActionStep[]): HeaderProduce[] {
  const byKey = new Map<string, HeaderProduce>();
  for (const step of actionSteps) {
    for (const p of step.produces) {
      if (p.kind !== "header") continue;
      const key = `${p.targetHeader.toLowerCase()}\0${p.cookieName ?? ""}`;
      if (!byKey.has(key)) byKey.set(key, p);
    }
  }
  return [...byKey.values()];
}

/**
 * Reads the concrete string a response-body produce points at, by walking the
 * capture's response body along the produce path. Returns null when any segment
 * is absent or the leaf isn't a string. Shared by state-threading and the
 * producer-boundary binding so both resolve produced values identically.
 */
function resolveResponsePathValue(responseBody: unknown, path: string[]): string | null {
  let cursor: unknown = responseBody;
  for (const segment of path) {
    if (
      cursor !== null &&
      typeof cursor === "object" &&
      segment in (cursor as Record<string, unknown>)
    ) {
      cursor = (cursor as Record<string, unknown>)[segment];
    } else {
      return null;
    }
  }
  return typeof cursor === "string" ? cursor : null;
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
  const varNameByValue = deriveStateVarByValue(priorSteps);

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

/** A producer-boundary coordinate: the capture value, its `payload.<field>`
 * accessor, the bare field name to declare in the emitted schema, and the index
 * of the step that produces it (the only step whose body is bound whole — later
 * steps thread the produced state var as usual). */
interface ProducerBoundaryBinding {
  accessor: string;
  field: string;
  producerIndex: number;
}

/**
 * Finds the request-body coordinates a PRODUCING step must source from the
 * caller's payload instead of a frozen capture literal.
 *
 * A response-produced state var (see {@link compileActionSteps}' produces[]) is
 * threaded as `${var}` in every step AFTER its producer. In the producer itself
 * the value predates its own response, so {@link interpolateStateValues} has no
 * prior binding for it and the frozen recon literal (the recon persona's
 * jobId/jobSeqNo/jobTitle/jobLocation) leaks into every caller's submission. The
 * value's real origin for the producer is the same coordinate the caller
 * supplies — a payload field.
 *
 * WHY it keys off produces[] ∩ the producer's own body, never a field/site name:
 * the signal is purely structural — "a value this flow threads downstream AND
 * re-sends in the very step that first emitted it". The field name is the
 * produced var name verbatim (`pathToVarName`'s output = the wire key), so the
 * producer's payload field and the downstream `${var}` describe one logical
 * coordinate and share the same runtime value (the caller passes it, the site
 * echoes it).
 *
 * A coordinate that a HIGHER-priority source already maps to a `payload.<field>`
 * (an entry-URL param — e.g. a jobSeqNo) is NOT skipped: it is re-emitted here so
 * the whole-value pass binds it atomically on the producer step, reusing that
 * source's accessor. Otherwise state threading fragments the composite (a prefix
 * that a prior step produced) before the length-descending payload pass can match
 * it, and the collision guard then refuses the embedded remainder — stranding the
 * middle of the coordinate frozen. A value mapped to a NON-payload target (the
 * threaded txn id) is left untouched. UUID-shaped values are excluded entirely —
 * a re-sent UUID is a volatile/threaded id owned by another pass, not a caller
 * coordinate — and only WHOLE request-body leaves qualify, so every returned
 * value is one the whole-value pass will bind (and whose field must be declared).
 *
 * A field is NOT a caller coordinate when it is a per-step POSITION CONSTANT — the
 * step's own identifier that the harness varies as it walks the wizard (like
 * `stepIndex`). Such a field is produced-and-re-sent on every step, so it looks
 * like a coordinate, but each producer step echoes a DIFFERENT value; a genuine
 * coordinate (a jobId) is echoed with the SAME value on every step and the
 * per-value dedupe below leaves it a single entry. So any field bound to ≥2
 * distinct values across its producer steps is dropped wholesale: each step keeps
 * its own captured literal and the field is never declared as caller input.
 * Site-agnostic — the signal is value cardinality per field, not any field name.
 *
 * @param actions the compiled action steps (carry produces[] + request bodies)
 * @param alreadyBound capture value → existing accessor; a `payload.*` accessor
 *   is reused, a non-payload one (e.g. `txnId`) vetoes the value
 * @returns capture value → { accessor: "payload.<field>"; field; producerIndex }
 */
export function deriveProducerBoundaryBindings(
  actions: ActionStep[],
  alreadyBound: ReadonlyMap<string, string>
): Map<string, ProducerBoundaryBinding> {
  const bindings = new Map<string, ProducerBoundaryBinding>();
  for (let i = 0; i < actions.length; i++) {
    const step = actions[i]!;
    const bodyLeafValues = jsonBodyLeafValues(step.capture.requestPostData);
    for (const p of step.produces) {
      if (p.kind === "header") continue;
      const value = resolveResponsePathValue(step.capture.responseBody, p.path);
      if (value === null || value.length < MIN_STATE_VALUE_LENGTH) continue;
      if (bindings.has(value)) continue;
      // A UUID re-sent across steps is never a stable caller coordinate — it's a
      // per-call volatile id or the threaded transaction id (which the server may
      // echo, so it looks "produced"). Both are owned by their own passes (the
      // volatile regen / the hoisted `txnId`); binding one to a payload field
      // would freeze the recon's single id into every caller's submission.
      if (UUID_REGEX.test(value)) continue;
      // A value already mapped to a non-payload target (the threaded txn id) must
      // stay that target; only a `payload.*` accessor is reusable here.
      const existing = alreadyBound.get(value);
      if (existing !== undefined && !existing.startsWith("payload.")) continue;
      // Producer-boundary reuse: the value must re-appear as a WHOLE JSON leaf in
      // THIS step's own request body. Whole-leaf (not substring) keeps "in this
      // map" ⟺ "the whole-value pass will bind this value's `"<key>":"<value>"`
      // slot" ⟺ "its field must be declared"; a substring match would declare a
      // field the pass never references. A composite that embeds a shorter
      // coordinate (a jobId inside a jobSeqNo) still binds — each is its own whole
      // leaf, and the longer one's whole-value bind carries the embedded copy. A
      // non-JSON (multipart) body has no parseable leaves and the whole-value pass
      // can't rewrite it, so it never qualifies (`bodyLeafValues === null`).
      if (bodyLeafValues === null || !bodyLeafValues.some((leaf) => leaf === value)) continue;
      // Reuse the higher-priority source's field when present; otherwise the
      // produced var name IS the wire key (pathToVarName). Use it verbatim so it
      // stays consistent with the downstream `${<key>N}` var; don't PascalCase it
      // (that lowercases camelCase, e.g. jobId→Jobid, and diverges from both the
      // state var and the entry-URL-param raw-key convention).
      const field = existing !== undefined ? existing.slice("payload.".length) : p.name;
      if (!isValidJsIdentifier(field)) continue;
      // `pathToVarName` returns the sentinel `"value"` when a produce path has no
      // identifier segment (all array indices) — a meaningless caller field name.
      // Freeze such a value (it surfaces via the unbound-literal TODO for the
      // author to name) rather than shipping `payload.value`. A reused
      // higher-priority accessor is a real declared field, so only veto the
      // sentinel when the name came from `p.name`.
      if (existing === undefined && field === "value") continue;
      bindings.set(value, { accessor: `payload.${field}`, field, producerIndex: i });
    }
  }
  // Drop per-step position constants: a field bound to ≥2 distinct values across
  // its producer steps is the step's own identifier the harness walked, not a
  // caller coordinate (which is echoed with one stable value). Removing every
  // entry leaves each step's captured literal in place and undeclared.
  const distinctValuesByField = new Map<string, Set<string>>();
  for (const [value, binding] of bindings) {
    const values = distinctValuesByField.get(binding.field) ?? new Set<string>();
    values.add(value);
    distinctValuesByField.set(binding.field, values);
  }
  for (const [value, binding] of [...bindings]) {
    if ((distinctValuesByField.get(binding.field)?.size ?? 0) >= 2) bindings.delete(value);
  }
  return bindings;
}

/**
 * Binds a caller coordinate in a step's body BEFORE state threading runs, via a
 * JSON-key-anchored WHOLE-value rewrite (`"<key>":"<value>"` →
 * `"<key>":"${payload.<field>}"`).
 *
 * WHY before {@link interpolateStateValues} and not via its payload pass: a
 * composite coordinate like a jobLocation `"Torrington, Connecticut, United
 * States"` or a jobSeqNo `"AAA0000000000EXTERNALENUS"` contains inner tokens a
 * genuinely-prior step produces as its own state var (a `label`, a `refNum`).
 * Pass-1 state threading would fragment the string (`"Torrington, ${label}"`,
 * `"${refNum}0000000000EXTERNALENUS"`) before the length-descending payload pass
 * could match the full literal — and the collision guard then refuses to bind the
 * embedded remainder, stranding it frozen. Binding the whole coordinate first —
 * the same "swallow whole before inner passes reach in" discipline as
 * {@link applyStructuredValuePayloadSubstitutions} — keeps it atomic. Anchored on
 * the exact `"<key>":` slot, so it only fires on a value's own JSON slot.
 *
 * `producerScoped` bindings fire only on their producing step
 * (`producerIndex === stepIndex`): a later step re-sending the same coordinate
 * threads the produced state var, the established behavior; only the producer,
 * which cannot thread its own not-yet-existent response, needs the payload bind.
 * `entryUrlBindings` (a caller coordinate lifted from the entry URL) fire on
 * EVERY step — they are the caller's data on every request, never a produced var.
 */
function applyWholeValuePayloadSubstitutions(
  template: string,
  parsedBody: unknown,
  producerScoped: Map<string, ProducerBoundaryBinding>,
  entryUrlBindings: ReadonlyMap<string, string>,
  stepIndex: number
): string {
  if (producerScoped.size === 0 && entryUrlBindings.size === 0) return template;
  let result = template;
  for (const { value, path } of walkStringLeaves(parsedBody)) {
    const scoped = producerScoped.get(value);
    const accessor =
      scoped !== undefined && scoped.producerIndex === stepIndex
        ? scoped.accessor
        : entryUrlBindings.get(value);
    if (accessor === undefined) continue;
    const key = path[path.length - 1] ?? "";
    if (key.length === 0) continue;
    const target = `"${key}":${JSON.stringify(value)}`;
    const replacement = `"${key}":"\${${accessor}}"`;
    result = result.split(target).join(replacement);
  }
  return result;
}

/** Maximum number of nested URL-encodings a query-param value is probed for
 * before giving up. Real captures observed a doubly-encoded value (`%2520`); the
 * extra headroom costs one cheap `decodeURIComponent` per level and stops runaway. */
const MAX_URL_PARAM_DECODE_DEPTH = 3;

/**
 * Maps each response-produced value to the `${var}` name later steps thread it as.
 * Shared by {@link interpolateStateValues} (the body/URL substitution) and the
 * URL-param pass, so a threaded coordinate (e.g. a jobId a prior step produced)
 * resolves to the same var in both — one source of truth, they can never diverge.
 *
 * Header/cookie-origin produces are skipped: they have no body path and their
 * value never appears as a literal in a URL/body template (http-client's `bind`
 * forwards it directly as a request header), so there is nothing to interpolate.
 */
function deriveStateVarByValue(priorSteps: ActionStep[]): Map<string, string> {
  const varNameByValue = new Map<string, string>();
  for (const step of priorSteps) {
    for (const p of step.produces) {
      if (p.kind === "header") continue;
      const value = resolveResponsePathValue(step.capture.responseBody, p.path);
      if (value !== null) varNameByValue.set(value, p.name);
    }
  }
  return varNameByValue;
}

/** One `decodeURIComponent`, or null when the input is not validly percent-encoded
 * (a stray `%` throws) — lets the progressive-decode loop stop instead of crash. */
function safeDecodeOnce(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** True when a JSON string leaf is itself an http(s) URL, the only leaves whose
 * query string this pass rewrites. Site-agnostic: a structural test, not a key name. */
function isHttpUrlLeaf(value: string): boolean {
  if (!value.includes("://")) return false;
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Wraps an accessor expression in `encodeURIComponent(...)` `depth` times, so a
 * value the capture stored URL-encoded is re-encoded to the same nesting at call
 * time (a caller value with `&`/`=`/spaces then survives inside the query string). */
function wrapEncode(expr: string, depth: number): string {
  let out = expr;
  for (let d = 0; d < depth; d++) out = `encodeURIComponent(${out})`;
  return out;
}

/**
 * Binds caller coordinates that were copied into a URL-valued body field's query
 * string. Every other substitution pass matches whole leaf values, so a job
 * coordinate re-encoded inside a redirect/thank-you URL stays frozen at the recon
 * persona's value. This runs on the PRISTINE parsed body leaf — before state
 * threading fragments a composite — and rewrites each query-param value that
 * matches the unified binding table (after bounded progressive URL-decoding, so a
 * double-encoded copy is caught) into a `${encodeURIComponent(<accessor>)}`
 * fragment nested to the matched encode depth. Unmatched params (and the delimiters
 * around them) stay byte-for-byte. Site-agnostic: keys off "leaf parses as an
 * http(s) URL", never a field name.
 */
function applyUrlParamPayloadSubstitutions(
  template: string,
  parsedBody: unknown,
  bindings: ReadonlyMap<string, string>
): string {
  if (bindings.size === 0) return template;
  let result = template;
  for (const { value, path } of walkStringLeaves(parsedBody)) {
    if (!isHttpUrlLeaf(value)) continue;
    const qIdx = value.indexOf("?");
    if (qIdx < 0) continue;
    const prefix = value.slice(0, qIdx + 1);
    const rawQuery = value.slice(qIdx + 1);
    let changed = false;
    const newParams = rawQuery.split("&").map((pair) => {
      const eq = pair.indexOf("=");
      if (eq < 0) return pair;
      const name = pair.slice(0, eq);
      const rawVal = pair.slice(eq + 1);
      if (rawVal.length < MIN_STATE_VALUE_LENGTH) return pair;
      if (CACHE_BUSTER_QUERY_KEYS.has(name)) return pair;
      let candidate = rawVal;
      let matched: string | null = null;
      let depth = 0;
      for (let d = 0; d <= MAX_URL_PARAM_DECODE_DEPTH; d++) {
        const accessor = bindings.get(candidate);
        if (accessor !== undefined) {
          matched = accessor;
          depth = d;
          break;
        }
        const next = safeDecodeOnce(candidate);
        if (next === null || next === candidate) break;
        candidate = next;
      }
      if (matched === null) return pair;
      changed = true;
      return `${name}=\${${wrapEncode(matched, depth)}}`;
    });
    if (!changed) continue;
    const newUrl = prefix + newParams.join("&");
    const key = path[path.length - 1] ?? "";
    if (key.length === 0) continue;
    const target = `"${key}":${JSON.stringify(value)}`;
    const replacement = `"${key}":"${newUrl}"`;
    result = result.split(target).join(replacement);
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
  // Only NEW keys need to be added to discovered-form-fields — inputBody's
  // own keys stay internal to the site request template, not the public
  // payload schema (see basePayloadSchemaExpr in emitContractTs).
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
      // can add them to the payload schema — inputBody's own keys stay
      // internal to the site request template (see basePayloadSchemaExpr).
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

/**
 * Documented closed set of JSON-key-name fragments (matched case-insensitively)
 * that mark a value as a per-request TIMESTAMP the plugin must generate fresh at
 * call time, not replay from the capture. Closed set per the no-regex-on-open-
 * sets feedback, matching {@link CACHE_BUSTER_QUERY_KEYS}'s posture. A frozen
 * capture timestamp would make every submission claim the recon instant.
 */
const VOLATILE_TIMESTAMP_KEY_FRAGMENTS = ["timestamp", "esign", "signeddate", "signedat"];

/** JSON-key-name suffix marking a value as a per-request time the plugin must
 * regenerate (e.g. `stepStartTime`, `submissionTime`). Separate from the
 * fragment set so it anchors on the suffix and doesn't match `runtime`/`downtime`. */
const VOLATILE_TIME_KEY_SUFFIX = "time";

function isVolatileTimestampKey(key: string): boolean {
  const k = key.toLowerCase();
  if (VOLATILE_TIMESTAMP_KEY_FRAGMENTS.some((frag) => k.includes(frag))) return true;
  return k.endsWith(VOLATILE_TIME_KEY_SUFFIX) && k !== "time";
}

/**
 * Rewrites per-request VOLATILE values in a body template so the generated
 * plugin produces them at call time instead of replaying the capture's:
 *   - a UUID-valued leaf → a fresh `crypto.randomUUID()`
 *   - a timestamp/eSign/-time-named leaf → a fresh `new Date().toISOString()`
 *
 * Walks the PARSED body (so keys are known) and rewrites JSON-key-anchored
 * (`"key":JSON.stringify(value)`), the same closed-set idiom as
 * {@link applyPayloadKeyValueSubstitutions}, recursing to ANY depth so nested
 * analytics/step blobs (`eventData`, `stepInfo[]`) are neutralized too. Values
 * in `shieldedUuids` (schema field-id/option-id anchors) or `boundValues` (a
 * value already substituted to `${payload…}`/`${txnId}`/state) are left alone
 * — an already-threaded transaction id or a bound email is not volatile.
 *
 * `crypto`/`Date` are bare Node/JS globals in the generated file (which already
 * uses `Buffer` bare); the `${…}` fragments are assembled by concatenation so
 * Biome's noTemplateCurlyInString doesn't flag THIS file's source.
 */
function applyVolatileFieldSubstitutions(
  template: string,
  parsedBody: unknown,
  shieldedUuids: Set<string>,
  boundValues: Set<string>
): string {
  const uuidGen = `$${"{"}crypto.randomUUID()${"}"}`;
  const isoGen = `$${"{"}new Date().toISOString()${"}"}`;
  let result = template;
  for (const { value, path } of walkAllPrimitiveLeaves(parsedBody)) {
    if (typeof value !== "string" || value.length === 0) continue;
    if (shieldedUuids.has(value) || boundValues.has(value)) continue;
    const key = path[path.length - 1] ?? "";
    const replacement = UUID_REGEX.test(value)
      ? uuidGen
      : isVolatileTimestampKey(key)
        ? isoGen
        : null;
    if (replacement === null) continue;
    const target = `"${JSON.stringify(value).slice(1, -1)}"`;
    result = result.split(target).join(`"${replacement}"`);
  }
  return result;
}

/**
 * Collects captured string leaves that survived every binding/generation pass as
 * still-literal — the values a reviewer must look at because they couldn't be
 * traced to a payload field, a generator, or a schema anchor. Returns the JSON
 * key names (deduped, in first-seen order) so the emitter can prepend a single
 * `// TODO: unbound captured literal` marker; it never mutates the body, so the
 * file still compiles. Short values (< {@link MIN_STATE_VALUE_LENGTH}) are
 * skipped — they are the legitimately-constant enum-like fields.
 */
function collectUnboundLiterals(
  finalTemplate: string,
  parsedBody: unknown,
  shieldedUuids: Set<string>
): string[] {
  const unbound: string[] = [];
  const seen = new Set<string>();
  for (const { value, path } of walkAllPrimitiveLeaves(parsedBody)) {
    if (typeof value !== "string" || value.length < MIN_STATE_VALUE_LENGTH) continue;
    if (shieldedUuids.has(value)) continue;
    const key = path[path.length - 1] ?? "";
    if (seen.has(key)) continue;
    // Still a bare literal in the emitted template (no ${…} took its place).
    if (finalTemplate.includes(JSON.stringify(value))) {
      seen.add(key);
      unbound.push(key);
    }
  }
  return unbound;
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
      // Humanize the wire key generically (CamelCase → "camel case"); no
      // per-vendor special cases — the engine carries no vendor's key vocabulary.
      const label = errorKey
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
  formSchema: ReconFormSchema | null = null,
  personaBindings: Map<string, string> = new Map(),
  entryUrlParams: Map<string, string> = new Map(),
  shieldedUuids: Set<string> = new Set(),
  selectResolutions: SelectOptionResolution[] = [],
  outStructuredKeys: Map<string, string> = new Map(),
  rawCodeFields: Map<string, { wireKey: string; code: string }> = new Map()
): string {
  interface Rendered {
    url: string;
    method: string;
    headersExpr: string;
    bodyArg: string;
    schemaExpr: string;
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
  // Persona identity bindings (from the flow's quoted literals + RECON_EMAIL,
  // paired to a payload field by the consumer vocabulary). Merged into the same
  // value→accessor map so `interpolateStateValues`' length-descending payload
  // pass substitutes them at ANY nesting depth — the fix for nested ATS bodies
  // like `formData.firstName` that the top-level-only key pass never reached.
  //
  // Collision guard (not a blunt length floor): that pass replaces by UNANCHORED
  // `String.split(value)`, so a persona value that appears INSIDE a longer token
  // would corrupt it — e.g. a `Select 'No' …` answer a vocabulary mapped to a
  // field would rewrite the "No" inside "Nursing"/"Not". A value binds only when
  // every occurrence across the action bodies sits at a token boundary (the
  // adjacent character is a non-alphanumeric JSON delimiter like `"`, space, or
  // punctuation), never flanked by alphanumerics. This keeps legitimately-short
  // identity values that don't collide (a 5-digit zip `06103`, a first name that
  // also appears space-delimited inside a signature) while dropping genuinely
  // dangerous substrings, which then surface via the unbound-literal TODO.
  // State-threaded produced values still win — they run in Pass 1, before this.
  const actionBodies = actions
    .map((a) => a.capture.requestPostData)
    .filter((b): b is string => typeof b === "string" && b.length > 0);
  const isAlnum = (ch: string | undefined): boolean => ch !== undefined && /[A-Za-z0-9]/.test(ch);
  const bindsWithoutCollision = (value: string): boolean => {
    for (const body of actionBodies) {
      let from = 0;
      while (true) {
        const at = body.indexOf(value, from);
        if (at === -1) break;
        // Flanked by an alphanumeric on either side → it's a substring of a
        // longer token; binding it would mangle that token. Block the value.
        if (isAlnum(body[at - 1]) || isAlnum(body[at + value.length])) return false;
        from = at + value.length;
      }
    }
    return true;
  };
  for (const [value, accessor] of personaBindings) {
    if (value.length === 0) continue;
    if (!bindsWithoutCollision(value)) continue;
    if (!payloadAccessorByValue.has(value)) payloadAccessorByValue.set(value, accessor);
    const field = accessor.startsWith("payload.") ? accessor.slice("payload.".length) : null;
    if (field !== null && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(field)) outDiscoveredFields.add(field);
  }
  // Job coordinates from the recon entry URL's query string (e.g.
  // `?jobSeqNo=...`). Registered the same way as BaseUrl so every verbatim
  // occurrence — and, via length-descending order, embedded substrings like a
  // jobId inside a jobSeqNo — rewrites to the caller-supplied value.
  for (const [value, accessor] of entryUrlParams) {
    if (value.length === 0) continue;
    if (!payloadAccessorByValue.has(value)) payloadAccessorByValue.set(value, accessor);
    const field = accessor.startsWith("payload.") ? accessor.slice("payload.".length) : null;
    if (field !== null && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(field)) outDiscoveredFields.add(field);
  }
  // Producer-boundary job coordinates: values a step's response produces (and
  // steps 2..N thread as `${var}`) that ALSO appear in that producing step's
  // own request body. The producer cannot thread its own not-yet-existent
  // response, so those slots would freeze the recon persona's coordinate; bind
  // them to the caller's payload instead. Registered here so the length-
  // descending payload pass rewrites short/embedded coordinates (a jobId inside
  // a jobSeqNo); the whole-value pass below binds composite coordinates a state
  // var would otherwise fragment. `bindsWithoutCollision`-guarded like personas.
  const producerBoundaryBindings = deriveProducerBoundaryBindings(
    actions,
    new Map(payloadAccessorByValue)
  );
  for (const [value, { accessor, field }] of producerBoundaryBindings) {
    // Always declare: the whole-value pass binds this value's own JSON slot on
    // its producer step regardless of collision, so the schema MUST carry the
    // field or the emitted `${payload.<field>}` references an undeclared property.
    outDiscoveredFields.add(field);
    // The UNANCHORED length-descending registration stays collision-guarded: it
    // rewrites embedded substrings globally, so a value that also sits inside a
    // longer token (a jobId within a jobSeqNo) must not be registered here — the
    // whole-value pass already binds its standalone slot atomically.
    if (bindsWithoutCollision(value) && !payloadAccessorByValue.has(value)) {
      payloadAccessorByValue.set(value, accessor);
    }
  }
  // G2: register any tenant-subdomain header values as payload-supplied fields
  // (e.g. an `API-ShortName: "addus"` header becomes `payload.ApiShortName`).
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

  // Detect the flow's THREADED transaction id: a single UUID the site mints
  // once (on page load) and reuses across every submit body to correlate the
  // multi-step wizard — observed on real ATS flows where one such id spans
  // every step. A frozen capture UUID would collide across concurrent/real
  // submissions, so the plugin must mint ONE at call time and thread it — hence
  // it maps to a hoisted local, not a payload field. Identified generically:
  // the same non-shielded UUID present in ≥2 action bodies.
  const uuidBodyCounts = new Map<string, number>();
  for (const { capture } of actions) {
    const seen = new Set<string>();
    for (const v of jsonBodyLeafValues(capture.requestPostData) ?? []) {
      if (UUID_REGEX.test(v) && !shieldedUuids.has(v)) seen.add(v);
    }
    for (const v of seen) uuidBodyCounts.set(v, (uuidBodyCounts.get(v) ?? 0) + 1);
  }
  const threadedTxnId = [...uuidBodyCounts.entries()].find(([, n]) => n >= 2)?.[0] ?? null;
  // The value→`${txnId}` binding rides the same substitution map as payload
  // accessors (Pass 2 of interpolateStateValues); the hoisted `const txnId`
  // declaration is emitted once above the step sequence below. `txnId` is a
  // generic local name — the wire key it fills is whatever the body used.
  if (threadedTxnId !== null && !payloadAccessorByValue.has(threadedTxnId)) {
    payloadAccessorByValue.set(threadedTxnId, "txnId");
  }
  // Values already substituted to a `${…}` reference — the volatile pass must
  // NOT regenerate these (an already-threaded txn id or a bound email is not
  // volatile). Keyed by the concrete captured value.
  const boundValues = new Set<string>(payloadAccessorByValue.keys());
  // Captured literals that survived every pass — surfaced as a review TODO.
  const unboundLiteralKeys = new Set<string>();

  // Pass 1: render every step's emitted strings; collect referenced var names.
  const rendered: Rendered[] = [];
  for (let i = 0; i < actions.length; i++) {
    const step = actions[i]!;
    const cap = step.capture;
    const prior = actions.slice(0, i);
    const url = interpolateStateValues(cap.url, prior, payloadAccessorByValue);
    // Form-schema substitution runs first on the raw recon body so its
    // field-id-anchored matches see the original JSON. State-threading and
    // payload key-value passes then run on top. Option-id substitution runs
    // here too: same closed-set field-id anchor; rewrites the submitted
    // option-id slots to "${OPT_X[payload.X]}" lookups.
    // Form-schema passes only fire when a `--form-schema` was supplied (which is
    // also the only way the field maps are non-empty); without one they are
    // no-ops and the raw recon body flows straight through.
    const rawBodyWithFormSubs =
      cap.requestPostData && formSchema !== null
        ? applyRawOptionIdPayloadSubstitutions(
            applyFormSchemaOptionIdSubstitutions(
              applyFormSchemaSubstitutions(
                cap.requestPostData,
                fieldNameMap,
                outDiscoveredFields,
                formSchema
              ),
              fieldOptionsMap,
              outDiscoveredOptionFields,
              formSchema
            ),
            fieldNameMap,
            fieldOptionsMap,
            outDiscoveredRawOptionFields,
            formSchema
          )
        : (cap.requestPostData ?? "");
    // Parsed once and shared by the structured (Mechanism B) and volatile passes
    // below — both walk the same body JSON, so parsing twice would be redundant.
    // null for absent/non-JSON bodies (multipart raw bytes), which both passes skip.
    const parsedBody = ((): unknown => {
      if (!cap.requestPostData) return null;
      try {
        return JSON.parse(cap.requestPostData);
      } catch {
        return null;
      }
    })();
    // Mechanism B — parameterize whole nested caller structures
    // (experienceData/educationData history, opaque eventData) BEFORE value
    // substitution reaches inside them: swallowing the entire array/object first
    // keeps interpolateStateValues from binding a code buried in the history
    // sample (e.g. a work entry's state code) to an unrelated field.
    const rawBodyWithStructuredSubs =
      parsedBody !== null
        ? applyStructuredValuePayloadSubstitutions(
            rawBodyWithFormSubs,
            parsedBody,
            outStructuredKeys
          )
        : rawBodyWithFormSubs;
    // Whole-value caller coordinates bind here — after structured subs, BEFORE
    // state threading — so a composite coordinate (a jobLocation or jobSeqNo
    // whose inner tokens a prior step produces as a state var) binds as one
    // atomic `${payload.X}` before Pass 1 can fragment it. Producer-boundary
    // coordinates fire on their producer only; entry-URL coordinates on every
    // step. No-op on steps without a match.
    const rawBodyWithProducerBoundary =
      parsedBody !== null
        ? applyWholeValuePayloadSubstitutions(
            rawBodyWithStructuredSubs,
            parsedBody,
            producerBoundaryBindings,
            entryUrlParams,
            i
          )
        : rawBodyWithStructuredSubs;
    // Coordinates copied into a URL-valued leaf's query string bind here, BEFORE
    // interpolateStateValues — same discipline as the whole-value pass above. A
    // composite (a jobSeqNo whose prefix a prior step produces as a state var)
    // would otherwise be fragmented mid-URL by Pass 1's global split, stranding
    // the tail frozen. The unified table is highest-priority-last: a per-step
    // state var (jobId2) wins over the caller payload accessor for that same
    // coordinate on steps that thread it, matching the top-level slot's behaviour.
    const urlParamBindings = new Map<string, string>(payloadAccessorByValue);
    for (const [value, accessor] of entryUrlParams) urlParamBindings.set(value, accessor);
    for (const [value, binding] of producerBoundaryBindings) {
      if (binding.producerIndex === i) urlParamBindings.set(value, binding.accessor);
    }
    for (const [value, varName] of deriveStateVarByValue(prior)) {
      urlParamBindings.set(value, varName);
    }
    const rawBodyWithUrlParams =
      parsedBody !== null
        ? applyUrlParamPayloadSubstitutions(
            rawBodyWithProducerBoundary,
            parsedBody,
            urlParamBindings
          )
        : rawBodyWithProducerBoundary;
    const bodyAfterStateAndKv = rawBodyWithUrlParams
      ? applyPayloadKeyValueSubstitutions(
          interpolateStateValues(rawBodyWithUrlParams, prior, payloadAccessorByValue),
          inputBody,
          additionalBodies,
          outDiscoveredAdditionalBodyKeys
        )
      : "";
    // Mechanism A — generic (plain-JSON, wire-key-anchored) dropdown label→code
    // rewrite. Runs AFTER interpolateStateValues + the payload-KV pass, not
    // before: the emitted `${OPT_<Name>[…]}` placeholder embeds the PascalCase
    // field name, and a wizard step-slug value (e.g. stepNum "Disability") that
    // becomes a global `.split` payload binding would otherwise rewrite the
    // matching substring INSIDE that placeholder and corrupt it. The closed-set
    // `"<key>":"<code>"` slot (numeric code, nested key) survives both earlier
    // passes untouched, so matching it here is still exact.
    let bodyTemplate = cap.requestPostData
      ? applyGenericRawCodeSubstitutions(
          applyGenericOptionCodeSubstitutions(
            bodyAfterStateAndKv,
            selectResolutions,
            fieldOptionsMap,
            outDiscoveredOptionFields
          ),
          rawCodeFields
        )
      : bodyAfterStateAndKv;
    // Volatile pass: after persona/job/state/kv binding, regenerate any
    // remaining per-request UUID (fresh crypto.randomUUID()) and timestamp
    // (fresh new Date().toISOString()) so the plugin never replays the capture
    // instant. Recurses to any depth; skips schema anchors and already-bound
    // values (incl. the threaded txn id). Then flag whatever is STILL literal.
    if (bodyTemplate && parsedBody !== null) {
      bodyTemplate = applyVolatileFieldSubstitutions(
        bodyTemplate,
        parsedBody,
        shieldedUuids,
        boundValues
      );
      for (const key of collectUnboundLiterals(bodyTemplate, parsedBody, shieldedUuids)) {
        unboundLiteralKeys.add(key);
      }
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
    // G2: each call gets its own schema, inferred from this step's captured
    // response — the client-level schema (z.unknown() for multi-step flows,
    // see emitContractTs) stays the plugin's caller-facing contract, not what
    // validates any individual call. Without this override, HttpRequestInit.schema
    // would default to the client's z.unknown() and narrowing the caller-facing
    // contract would enforce that narrowed shape on every call in the chain.
    const schemaExpr = inferZodSchema(cap.responseBody);

    rendered.push({ url, method: cap.method, headersExpr, bodyArg, schemaExpr });
  }

  // Identifier scan against the rendered text — captures `${foo}`, `${foo.bar}`,
  // etc. The first segment (anchored at `${`) is the binding's name. Closed
  // grammar (template-literal syntax we generated ourselves). The optional
  // `encodeURIComponent(` prefixes let the URL-param pass wrap a bound accessor
  // (`${encodeURIComponent(jobTitle2)}`) without hiding the inner state var from
  // this scan — otherwise its `const` would be pruned and the reference dangle.
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
      for (const match of haystack.matchAll(
        /\$\{(?:encodeURIComponent\()*([A-Za-z_$][A-Za-z0-9_$]*)/g
      )) {
        referencedNames.add(match[1]!);
      }
    }
  }
  // The relevance-selected step's var is also referenced by the closing
  // `return { data }` — see selectReturnAction.
  const returnAction = selectReturnAction(actions);
  if (returnAction) referencedNames.add(returnAction.varName);

  // Pass 2: emit. Skip response bindings that aren't referenced; skip
  // produces[] entries whose name isn't referenced. A step's response var
  // is still needed when at least one of its produces[] entries IS
  // referenced — the produces line dereferences it.
  const lines: string[] = [];
  // Mint the threaded transaction id ONCE and reuse across every step — the
  // `${txnId}` references emitted into the bodies above all resolve to this
  // single call-time UUID, matching how the site mints one per application.
  // Emitted only when actually referenced (Biome noUnusedVariables).
  if (threadedTxnId !== null && referencedNames.has("txnId")) {
    lines.push(`    const txnId = crypto.randomUUID();`);
    lines.push("");
  }
  // Surface any captured literal that no pass could bind, so a reviewer knows
  // exactly which slots still carry recon data. Comment only — never blocks emit.
  if (unboundLiteralKeys.size > 0) {
    lines.push(
      `    // TODO: unbound captured literal(s) — verify these carry caller data, not the recon capture's: ${[...unboundLiteralKeys].join(", ")}`
    );
  }
  const declaredNames = new Set<string>();
  for (let i = 0; i < actions.length; i++) {
    const step = actions[i]!;
    const cap = step.capture;
    const r = rendered[i]!;
    // Build the produce-extraction lines FIRST so the binding decision reflects
    // what is actually emitted, not a pre-scan predicate. A produce whose name
    // was already declared by an earlier step is de-dup-skipped here — and must
    // NOT keep this step's response bound, or `rN` is bound but never read
    // (Biome `noUnusedVariables`). `assertNonNull: false`: the `pathToAssertionType`
    // cast uses string-literal keys, so the accessor needs no `!` (and a `!`
    // would trip Biome `noNonNullAssertion`).
    const produceLines: string[] = [];
    for (const p of step.produces) {
      // Header/cookie-origin produces never surface as a JS accessor —
      // createHttpClient's `bind` option (rendered once, above the steps)
      // captures and forwards the value internally.
      if (p.kind === "header") continue;
      if (declaredNames.has(p.name)) continue;
      if (!referencedNames.has(p.name)) continue;
      declaredNames.add(p.name);
      const assertion = pathToAssertionType(p.path);
      produceLines.push(
        `    const ${p.name} = (${step.varName} as ${assertion})${pathToAccessor(p.path, { assertNonNull: false })};`
      );
    }
    const bindResponse = referencedNames.has(step.varName) || produceLines.length > 0;

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
      lines.push(`      schema: ${r.schemaExpr},`);
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

    for (const line of produceLines) lines.push(line);
    lines.push("");
  }

  const returnVar = returnAction ? returnAction.varName : "undefined";
  lines.push(`    return { data: ${returnVar} };`);

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
/**
 * Splices a payload field into a string variable that packs filter facets as
 * delimited `key:value` segments (e.g. a product-catalog `filters` variable
 * shaped like `category:widgets|priceRange:10~50`) — the shape GraphQL search
 * endpoints commonly use instead of exposing each facet as its own top-level
 * variable, which is otherwise invisible to the key-name-equality strategy in
 * {@link renderGqlVariablesExpr}. Returns `null` for non-string values or
 * strings with no delimiter-separated `key:value` segment, and for strings
 * whose facet keys correlate with none of `fields`, so opaque tokens, JSON
 * blobs, and plain literals fall through to the existing JSON.stringify path
 * unchanged.
 */
function spliceFacetsIntoStringVariable(value: unknown, fields: readonly string[]): string | null {
  if (typeof value !== "string") return null;
  const segments = value.split(/([|,;])/);
  const hasFacetShape = segments.some((segment, index) => index % 2 === 0 && segment.includes(":"));
  if (!hasFacetShape) return null;
  const matchedFieldIndex = segments.findIndex(
    (segment, index) =>
      index % 2 === 0 &&
      segment.includes(":") &&
      fields.some(
        (field) => field.toLowerCase() === segment.slice(0, segment.indexOf(":")).toLowerCase()
      )
  );
  if (matchedFieldIndex === -1) return null;
  const matchedSegment = segments[matchedFieldIndex] as string;
  const matchedColonIndex = matchedSegment.indexOf(":");
  const facetKey = matchedSegment.slice(0, matchedColonIndex);
  const matchedField = fields.find(
    (field) => field.toLowerCase() === facetKey.toLowerCase()
  ) as string;
  const before = `${segments.slice(0, matchedFieldIndex).join("") + facetKey}:`;
  const after = segments.slice(matchedFieldIndex + 1).join("");
  return `\`${escapeForTemplateLiteral(before)}\${payload.${matchedField}}${escapeForTemplateLiteral(after)}\``;
}

/**
 * Renders the variables literal for the primary-operation getGql() call —
 * each key from the selected capture's own recorded variables is bound to
 * `payload.<Field>` when it correlates (case-insensitively) with one of the
 * flow's payloadFieldNames. When no top-level key correlates and the value is
 * a string packing facets in a delimited `key:value` grammar (see
 * {@link spliceFacetsIntoStringVariable}), a correlated facet's value slot is
 * spliced with `payload.<Field>` instead of freezing the whole string; any
 * other value is emitted verbatim via JSON.stringify.
 */
function renderGqlVariablesExpr(
  variables: unknown,
  payloadFieldNames: Set<string> | undefined
): string {
  if (variables === null || typeof variables !== "object" || Array.isArray(variables)) return "{}";
  const fields = payloadFieldNames ? [...payloadFieldNames] : [];
  const entries = Object.entries(variables as Record<string, unknown>).map(([key, value]) => {
    const matchedField = fields.find((field) => field.toLowerCase() === key.toLowerCase());
    const facetSpliceExpr = matchedField ? null : spliceFacetsIntoStringVariable(value, fields);
    const valueExpr = matchedField
      ? `payload.${matchedField}`
      : (facetSpliceExpr ?? JSON.stringify(value));
    return `${key}: ${valueExpr}`;
  });
  return entries.length > 0 ? `{ ${entries.join(", ")} }` : "{}";
}

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
  /** operationName recorded on the primary-operation capture selected by
   * {@link selectPrimaryGraphQLOperation} — when set, replaces the
   * `${pascal}Search` placeholder in the single-endpoint getGql() call. */
  gqlOperationName?: string | null;
  /** variables recorded on that same capture — when set alongside
   * {@link gqlOperationName}, replaces the `{ q: payload.query }` placeholder,
   * with keys bound to `payload.<Field>` where they correlate with
   * `payloadFieldNames`. */
  gqlVariables?: unknown;
  auxFiles: string[];
  /** Multi-step submission flow body — when set, replaces the default single-endpoint hot path. */
  multiStepBody?: string;
  /** Browser-flow-only fallback: a multi-action flow whose captured sequence
   * couldn't be synthesized into a trustworthy `executeHttp` (a required
   * value never resolved via state-threading, a payload field, or a
   * generator). When true, `executeHttp` is omitted entirely — the plugin
   * ships browser-only with the standard candidate payload schema — rather
   * than emitting a fabricated single-call HTTP stub. */
  omitExecuteHttp?: boolean;
  /** First action capture's request body — used to infer the payload schema for submission flows. */
  inputBody?: unknown;
  /** Whether the flow has a multipart upload step — derived from actionSteps at the call site. */
  hasMultipartStep?: boolean;
  /** PascalCase payload-field names discovered by walking the form schema and
   * substituting the submitted-value literals. Added to the payload schema so
   * the caller can supply real values for them. */
  discoveredFormFields?: Set<string>;
  /** Full field-options map (field-id → semanticName + options). Only the
   * entries whose semanticName is in `discoveredOptionFields` will get emitted
   * — those are the fields where applyFormSchemaOptionIdSubstitutions actually
   * rewrote an option-id slot. */
  fieldOptionsMap?: FieldOptionsMap;
  /** Semantic names whose option-id slots were rewritten by the generator —
   * each gets an OPT_<Name> constant and a z.enum payload field. */
  discoveredOptionFields?: Set<string>;
  /** Map of label-derived raw-option payload field name (e.g.
   * `WereYouReferredOptionId`) → recon-observed option-id UUID. Each becomes
   * a `<name>: z.string()` payload field with the recon-observed UUID
   * documented in a TSDoc comment. Used for options with empty labels
   * where T3's structured enum can't be emitted. */
  discoveredRawOptionFields?: Map<string, string>;
  /** Phase F: top-level keys observed in action POST bodies beyond r0
   * (inputBody). Mapped to their value type. Each becomes a payload field
   * (string → z.string(), number → z.number(), boolean → z.boolean()). */
  discoveredAdditionalBodyKeys?: Map<string, "string" | "number" | "boolean">;
  /** Mechanism B: top-level body keys whose value is a whole caller-supplied
   * nested structure (arrays like experienceData/educationData, or the opaque
   * eventData blob), mapped to the inferred Zod schema expression for that
   * value. Each becomes a `<key>: <schema>` payload field so the caller passes
   * its own history/analytics rather than replaying the recon sample. */
  discoveredStructuredKeys?: Map<string, string>;
  /** PascalCase candidate-PII field names the browser flow splices as
   * `payload.<field>` (from resolveStepPayloadField). Each is added to the
   * payload schema so those references typecheck. Shares the accumulator with
   * emitBrowserFlowTs so schema and flow can never drift. */
  payloadFieldNames?: Set<string>;
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
    gqlOperationName,
    gqlVariables,
    auxFiles,
    multiStepBody,
    omitExecuteHttp = false,
    inputBody,
    hasMultipartStep = false,
    discoveredFormFields,
    fieldOptionsMap,
    discoveredOptionFields,
    discoveredRawOptionFields,
    discoveredAdditionalBodyKeys,
    discoveredStructuredKeys,
    payloadFieldNames,
    headerBindings = [],
  } = opts;

  // This is the CLIENT-level schema — createHttpClient's default, and the
  // plugin's caller-facing contract (what executeHttp's return value promises
  // its own caller). It does NOT validate any individual call in a multi-step
  // flow: emitMultiStepExecuteHttp threads a per-call `schema:` override
  // (inferred from that step's own capture) onto every httpClient(...)
  // invocation, so heterogeneous per-call shapes are each checked against
  // their own inferred schema regardless of what this client-level schema is.
  //
  // For multi-step flows, `responseBody` here is already
  // `selectEffectiveResponseBody`'s pick — the SAME call `selectReturnAction`
  // returns from `executeHttp` (`return { data: r9 }` below, r9 being that
  // call's own already-validated result). Inferring the client-level schema
  // from it is therefore not a guess about a field the captures never showed:
  // it's the literal shape of the value the client hands back, captured by
  // its own success response (e.g. a `valid`/`errors`-shaped terminal body).
  // Single-endpoint plugins keep the same inferred-schema treatment, since
  // there both roles (client default and sole call) coincide.
  // Browser-flow-only plugins have no HTTP call to infer a shape from —
  // z.unknown() there is the honest gap, not a narrowing shortcut.
  const responseSchemaExpr = omitExecuteHttp ? `z.unknown()` : inferZodSchema(responseBody);
  // Multi-step flows that include a multipart upload need the binary asset
  // on the payload. ApplicantContactSchema (via ApplicantResumeSchema) already
  // declares Resume/ResumeContentType/ResumeFilename, so submission flows
  // (inputBody set) get them from basePayloadSchemaExpr with no extra extend
  // needed here. A query-type flow (inputBody unset) that still has a
  // multipart step — hasMultipartStep is computed independently from
  // actionSteps.some(s.isMultipart) and can be true even for a single-step,
  // non-submission flow — does NOT get those fields from basePayloadSchemaExpr
  // (its base is just `{ query }`), so it still needs the explicit extend.
  // hasMultipartStep also still drives other emit decisions below (imports,
  // boolean coercion, meta.multipart).
  //
  // The captured request body (inputBody) is the SITE's internal request
  // shape (a vendor's ddoKey/formData, a GraphQL worklet's variables, …) — not
  // what the real caller sends. The plugin's buildBarnacleFormData posts
  // the standard candidate payload (ApplicantContactSchema's identity/
  // address/resume fields + Email + job-targeting + a JSON Answers block) to
  // every plugin's /run, so that — not a structural inference over
  // inputBody — is the public contract every submission-flow plugin must
  // declare, unconditionally (see recon-generate-payload-schema-mismatch.md
  // fix option (a)). inputBody remains available to the plugin author as the
  // internal request shape the site's own call needs to be built from; it no
  // longer drives the public schema. A missing inputBody means this is a
  // non-submission (query-type) flow, which keeps its own contract untouched.
  const basePayloadSchemaExpr = inputBody
    ? `ApplicantContactSchema`
    : `z.object({\n  query: z.string().min(1),\n})`;
  // Every field source below (the base extend's own keys, form-schema
  // discovery, browser-flow splicing, option/raw-option enums, additional
  // body keys, and structured keys) is merged into a SINGLE `.extend({...})`
  // object literal, keyed by field name, rather than each becoming its own
  // chained `.extend()` call. A name that recurs across sources collapses to
  // one declaration — the later source in this list wins, mirroring the
  // override semantics a chain of `.extend()` calls used to have (each
  // subsequent `.extend` replaced an earlier field of the same name).
  const extendFields = new Map<string, string>();
  const addExtendField = (name: string, line: string): void => {
    extendFields.set(name, line);
  };

  // The base extend's own keys — submission flows only.
  if (inputBody) {
    addExtendField("Email", "  Email: z.email(),");
    addExtendField("ClickUrl", "  ClickUrl: z.string().min(1),");
    addExtendField("Answers", "  Answers: multipartJsonObject(z.record(z.string(), z.unknown())),");
  }

  // ApplicantContactSchema's own merged identity/address/resume field names
  // (see src/lib/application-identity.ts, application-address.ts,
  // application-resume.ts, applicant-payload.ts) — reserved so no discovered/
  // spliced source can redeclare (and silently shadow) a field the base
  // ApplicantContactSchema already supplies. Only relevant for submission
  // flows, where basePayloadSchemaExpr actually is ApplicantContactSchema.
  const applicantContactFieldNames = new Set([
    "FirstName",
    "LastName",
    "Phone",
    "AddressLine",
    "City",
    "State",
    "PostalCode",
    "Country",
    "County",
    "Resume",
    "ResumeContentType",
    "ResumeFilename",
    "ResumeBase64",
  ]);
  const isReservedByApplicantContactSchema = (name: string): boolean =>
    Boolean(inputBody) && applicantContactFieldNames.has(name);

  // Multi-step flows that include a multipart upload need the binary asset
  // on the payload. A query-type flow (no ApplicantContactSchema base) still
  // needs these fields spelled out explicitly.
  if (hasMultipartStep && !inputBody) {
    addExtendField("Resume", "  Resume: z.instanceof(Buffer),");
    addExtendField("ResumeContentType", "  ResumeContentType: z.string(),");
    addExtendField("ResumeFilename", "  ResumeFilename: z.string(),");
  }

  // Form-schema-discovered fields (e.g. AddressLine1, UserSsn, Reference1FirstName)
  // are added to the payload as required strings. Site-agnostic: the set is
  // populated by applyFormSchemaSubstitutions when the recon includes a
  // detectable form schema; empty for sites without one.
  if (discoveredFormFields) {
    for (const name of [...discoveredFormFields].sort()) {
      if (isReservedByApplicantContactSchema(name)) continue;
      addExtendField(name, `  ${name}: z.string(),`);
    }
  }

  // Candidate-PII fields the browser flow splices as `payload.<field>`. Emitted
  // as required strings (z.email() for Email per the repo's z.string().email()→
  // z.email() migration) so those references typecheck in the generated flow.
  if (payloadFieldNames) {
    for (const name of [...payloadFieldNames].sort()) {
      if (isReservedByApplicantContactSchema(name)) continue;
      addExtendField(name, `  ${name}: ${name === "Email" ? "z.email()" : "z.string()"},`);
    }
  }

  // Build per-field OPT_<Name> constant declarations + payload-schema enum
  // entries from the form schema's options. Only fields whose option-id
  // slots were actually rewritten in the body (i.e. that appear in
  // discoveredOptionFields) get emitted; the rest leave their schema entries
  // unused.
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
  for (const mapping of emittedOptionMappings) {
    if (isReservedByApplicantContactSchema(mapping.semanticName)) continue;
    addExtendField(
      mapping.semanticName,
      `  ${mapping.semanticName}: z.enum([${mapping.options.map((o) => JSON.stringify(o.value)).join(", ")}]),`
    );
  }

  // Phase E raw-option payload fields: options whose label strings are empty in
  // the schema — no semantic enum is possible, so the caller supplies the
  // option-id UUID directly. The recon-observed UUID is documented in a TSDoc
  // comment so callers have a starting point.
  const sortedRawOptionEntries = discoveredRawOptionFields
    ? [...discoveredRawOptionFields.entries()].sort(([a], [b]) => a.localeCompare(b))
    : [];
  for (const [name, reconUuid] of sortedRawOptionEntries) {
    if (isReservedByApplicantContactSchema(name)) continue;
    addExtendField(
      name,
      `  /** Recon-observed: ${reconUuid}. Caller supplies the option-id UUID for this field. */\n  ${name}: z.string(),`
    );
  }

  // A non-scalar (Mechanism B) field forces multipart wire encoding just like
  // an upload step does: the multipart body encodes arrays/objects as
  // JSON-stringified strings, so those fields need the same
  // multipartJsonObject() parsing Answers already gets in basePayloadSchemaExpr.
  const payloadNeedsMultipart = hasMultipartStep || (discoveredStructuredKeys?.size ?? 0) > 0;

  // Phase F: additional-body keys (from action POSTs beyond r0). Each gets a
  // payload field of the appropriate Zod type. Site-agnostic.
  const sortedAdditionalKeys = discoveredAdditionalBodyKeys
    ? [...discoveredAdditionalBodyKeys.entries()].sort(([a], [b]) => a.localeCompare(b))
    : [];
  for (const [name, kind] of sortedAdditionalKeys) {
    if (isReservedByApplicantContactSchema(name)) continue;
    // Use multipartBoolean() for booleans when multipart is in play, so
    // multipart string-encoded "true"/"false" round-trip to native booleans
    // (matches the inputBody boolean handling for parity).
    const zod =
      kind === "string"
        ? "z.string()"
        : kind === "number"
          ? payloadNeedsMultipart
            ? "z.coerce.number()"
            : "z.number()"
          : payloadNeedsMultipart
            ? "multipartBoolean()"
            : "z.boolean()";
    addExtendField(name, `  ${name}: ${zod},`);
  }

  // Mechanism B: nested caller structures become payload fields carrying their
  // inferred schema. Emitted as an object body so multi-line z.array(z.object(
  // …)) expressions indent cleanly; a leading TSDoc flags eventData's opaque
  // passthrough so callers know its nested volatiles are theirs to mint.
  const sortedStructuredEntries = discoveredStructuredKeys
    ? [...discoveredStructuredKeys.entries()].sort(([a], [b]) => a.localeCompare(b))
    : [];
  for (const [name, schema] of sortedStructuredEntries) {
    if (isReservedByApplicantContactSchema(name)) continue;
    const key = isValidJsIdentifier(name) ? name : JSON.stringify(name);
    const value = payloadNeedsMultipart ? `multipartJsonObject(${schema})` : schema;
    addExtendField(name, `  ${key}: ${value},`);
  }

  // The structural walk over the captured request body that used to BE the
  // public payload schema (see basePayloadSchemaExpr above) is still the
  // right starting point for the plugin author's internal builder — it's
  // what the site itself expects on the wire, just no longer what the
  // platform caller sends. Demoted to a documented, unexported reference
  // construct per recon-generate-payload-schema-mismatch.md fix option (a),
  // matching the prior hand-fix precedent (an internal builder that
  // translates the standard payload into the site's request bodies).
  // Unconditional whenever inputBody is set — same gate as basePayloadSchemaExpr.
  const internalRequestReferenceExpr = inputBody
    ? inferZodSchema(inputBody, 0, "", { multipartCoerce: hasMultipartStep })
    : null;

  // All field sources above are merged into a SINGLE `.extend({...})` object
  // literal, keyed by field name — a name that recurs across sources (or
  // that collides with the base extend's own Email/ClickUrl/Answers) collapses
  // to its last-declared line, rather than becoming a second, dupe-prone
  // `.extend()` call chained onto the schema.
  const mergedExtension =
    extendFields.size > 0 ? `.extend({\n${[...extendFields.values()].join("\n")}\n})` : "";
  const payloadSchemaExpr = `${basePayloadSchemaExpr}${mergedExtension}`;
  // basePayloadSchemaExpr's own Answers field always wraps in
  // multipartJsonObject() for submission flows (inputBody set);
  // multipartBoolean() and the structured-keys wrapping above are needed
  // whenever payloadNeedsMultipart is true (an upload step OR a non-scalar
  // discoveredStructuredKeys field).
  // Named imports from the same module are combined into one import statement.
  const zodMultipartNamedImports = [
    ...(payloadNeedsMultipart ? ["multipartBoolean"] : []),
    ...(inputBody || (payloadNeedsMultipart && sortedStructuredEntries.length > 0)
      ? ["multipartJsonObject"]
      : []),
  ];
  const multipartBoolImport =
    zodMultipartNamedImports.length > 0
      ? `import { ${zodMultipartNamedImports.join(", ")} } from "${ENGINE_PKG}/lib/zod-multipart";\n`
      : "";
  // ApplicantContactSchema backs the default submission-flow payload schema
  // (see basePayloadSchemaExpr above); only referenced when inputBody is set.
  const applicantContactImport = inputBody
    ? `import { ApplicantContactSchema } from "${ENGINE_PKG}/lib/applicant-payload";\n`
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

  // Browser-flow-only plugins have no direct-HTTP hot path, so none of the
  // client-construction machinery below (import, rate limiter, cache/client
  // const) is emitted — it would sit unreferenced and trip Biome's
  // `noUnusedVariables`.
  const clientImport = omitExecuteHttp
    ? ""
    : gql
      ? `import { createGraphqlClient } from "${ENGINE_PKG}/scraper/graphql-client";`
      : `import { createHttpClient } from "${ENGINE_PKG}/scraper/http-client";`;

  const queryConst =
    !omitExecuteHttp && gql && gqlQuery
      ? `\n// Lifted verbatim from recon capture — trim UI-only fields before shipping.\nconst ${pascal.toUpperCase()}_QUERY = \`${gqlQuery.trim()}\`;\n`
      : "";

  const gqlCacheBlock = omitExecuteHttp
    ? ""
    : gql
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

  const gqlOperationNameExpr = gqlOperationName
    ? JSON.stringify(gqlOperationName)
    : JSON.stringify(`${pascal}Search`);
  const gqlVariablesExpr = gqlOperationName
    ? renderGqlVariablesExpr(gqlVariables, payloadFieldNames)
    : "{ q: payload.query }";

  const executeHttpBody = multiStepBody
    ? multiStepBody
    : gql
      ? `    const data = await getGql(context.baseUrl)(${gqlOperationNameExpr}, ${pascal.toUpperCase()}_QUERY, ${gqlVariablesExpr});
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

  // Documented, unexported internal-reference construct: the site's own
  // captured request shape, kept available as builder input for whatever
  // code translates the standard ${pascal}Payload into the site's actual
  // request bodies (see the prior hand-fix precedent in
  // recon-generate-payload-schema-mismatch.md). Distinct from — and never
  // used to validate — the public ${pascal}PayloadSchema above.
  const internalRequestReferenceBlock = internalRequestReferenceExpr
    ? `
/**
 * The SITE's own request shape, as captured during recon — NOT the public
 * /run contract (see ${pascal}PayloadSchema above, which is what the real
 * caller sends). Exported so a builder module can import it as the target
 * shape when translating the standard payload into the site's own request
 * bodies (see recon-generate-payload-schema-mismatch.md's prior
 * hand-fix precedent).
 */
export const ${pascal}InternalRequestReference = ${internalRequestReferenceExpr};
`
    : "";

  const queryChecklistLine =
    !omitExecuteHttp && gql
      ? `\n *   [ ] Trim UI-only fields from ${pascal.toUpperCase()}_QUERY (keep only fields you need)`
      : "";

  // Multi-step flows validate each call against its own per-call inferred
  // schema (emitMultiStepExecuteHttp) — narrowing ResponseSchema only changes
  // what executeHttp promises ITS OWN caller, never a per-call validator, so
  // the checklist item must say that explicitly. Single-endpoint plugins have
  // exactly one call, so the client schema and that call's validator are the
  // same schema and the shorter wording stays accurate. Browser-flow-only
  // plugins have no executeHttp at all, so ResponseSchema is only ever the
  // browser flow's own return-value contract.
  const narrowSchemaChecklistLine = omitExecuteHttp
    ? `\n *   [ ] Narrow ${pascal}ResponseSchema to match what the browser flow should promise ITS CALLER — this flow could not synthesize a trustworthy executeHttp (a required value from the captured sequence never resolved), so it ships browser-only`
    : multiStepBody
      ? `\n *   [ ] Narrow ${pascal}ResponseSchema to match what executeHttp should promise ITS CALLER — this is the plugin's own return-value contract, not a per-call validator (each call in the flow is already checked against its own inferred schema)`
      : `\n *   [ ] Narrow ${pascal}ResponseSchema to match the real response shape`;

  const camel = siteId.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

  // Browser-flow-only plugins need neither Bottleneck (no rate-limited HTTP
  // client) nor BASE_HEADERS (no per-call headers to bake in) — both would
  // sit unreferenced and trip Biome's `noUnusedVariables`.
  const bottleneckImport = omitExecuteHttp ? "" : `import Bottleneck from "bottleneck";\n`;
  const baseHeadersBlock = omitExecuteHttp
    ? ""
    : `
const BASE_HEADERS: Record<string, string> = {
${headersLiteral},
};
`;
  const limiterBlock = omitExecuteHttp
    ? ""
    : `
// Safe ceiling: ${safeRps} rps — from recon rate-limit probe.
const limiter = new Bottleneck({ minTime: ${minTime} });
`;
  const executeHttpMethodBlock = omitExecuteHttp
    ? ""
    : `
  /** Hot path: direct HTTP — no browser, no LLM tokens. */
  async executeHttp(
    payload: ${pascal}Payload,
    ${executeHttpBody.includes("context.") ? "context" : "_context"}: SitePluginContext
  ): Promise<SitePluginResult<${pascal}Response>> {
${executeHttpBody}
  },
`;
  const pluginDocComment = omitExecuteHttp
    ? `/**
 * Plugin for ${siteId}. Browser-flow-only: the captured multi-step submission
 * sequence could not be synthesized into a trustworthy direct-HTTP hot path
 * (see the checklist above), so this always runs via Stagehand.
 */`
    : `/**
 * Plugin for ${siteId}. Tries the direct-HTTP hot path first; falls back to
 * Stagehand automatically on schema drift or bot challenge.
 */`;

  const baseHeadersChecklistLine = omitExecuteHttp
    ? ""
    : `\n *   [ ] Verify BASE_HEADERS — remove any that aren't load-bearing`;
  const outOfTreeChecklistLine = omitExecuteHttp
    ? `\n *   [ ] Out-of-tree: \`pnpm add zod\` — this file imports it directly, and a\n *       strict node_modules layout (pnpm) won't resolve it as a transitive\n *       dep of @enricai/barnacle alone`
    : `\n *   [ ] Out-of-tree: \`pnpm add bottleneck zod\` — this file imports both\n *       directly, and a strict node_modules layout (pnpm) won't resolve\n *       them as transitive deps of @enricai/barnacle alone`;

  return `/**
 * Generated by recon-generate.ts — review before shipping.
 *
 * Checklist:${queryChecklistLine}${narrowSchemaChecklistLine}
 *   [ ] Adjust ${pascal}PayloadSchema to your actual request parameters${baseHeadersChecklistLine}${outOfTreeChecklistLine}
 */

${bottleneckImport}import { z } from "zod/v4";

${fixtureImport}${applicantContactImport}${caseInsensitiveHeadersImport}${multipartBoolImport}${clientImport}
import type { BrowserSession } from "${ENGINE_PKG}/scraper/session";
import type { SitePlugin, SitePluginContext, SitePluginResult } from "${ENGINE_PKG}/site-plugin";
import { run${pascal}BrowserFlow } from "@/sites/${siteId}/flows/browser-flow";
${baseHeadersBlock}${limiterBlock}
const ${pascal}ResponseSchema = ${responseSchemaExpr};

export type ${pascal}Response = z.infer<typeof ${pascal}ResponseSchema>;

export default ${pascal}ResponseSchema;
${optionDecls}
const ${pascal}PayloadSchema = ${payloadSchemaExpr};

export type ${pascal}Payload = z.infer<typeof ${pascal}PayloadSchema>;
${internalRequestReferenceBlock}${queryConst}${gqlCacheBlock}${fixtureComments}
${pluginDocComment}
export const ${camel}Plugin: SitePlugin<${pascal}Payload, ${pascal}Response> = {
  meta: {
    siteId: ${JSON.stringify(siteId)},
    displayName: ${JSON.stringify(pascal.replace(/([A-Z])/g, " $1").trim())},
    bodySchema: ${pascal}PayloadSchema,
    responseSchema: ${pascal}ResponseSchema,
    defaultBaseUrl: ${JSON.stringify(baseUrl)},
    // multipart is required whenever the flow itself uploads a file
    // (hasMultipartStep), OR this is a submission flow (inputBody set) since
    // basePayloadSchemaExpr always requires a real Resume Buffer via
    // ApplicantContactSchema regardless of whether the recorded browser flow
    // contained an upload step, OR the payload has a non-scalar
    // discoveredStructuredKeys field (payloadNeedsMultipart), since the
    // multipart wire format is what makes that field's JSON-stringified
    // encoding parseable.
    apiVersion: ${JSON.stringify(PLUGIN_API_VERSION)},${payloadNeedsMultipart || inputBody ? "\n    multipart: true," : ""}
  },
${executeHttpMethodBlock}
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
 * The splice site is located by {@link locateSpliceSite} — a reserved
 * `${RECON_*}` env token when present, otherwise the quoted VALUE span (never
 * a selector's or label's quoted span), matching {@link extractStepPersonaValue}'s
 * own choice so the browser-flow and HTTP-body emitters never disagree on
 * which quoted span is the persona value.
 */
function buildStepInstructionExpr(instruction: string, field: string | null): string {
  if (field === null) return JSON.stringify(instruction);
  const site = locateSpliceSite(instruction);
  if (site === null) return JSON.stringify(instruction);
  return `\`${escapeForTemplateLiteral(site.before)}\${payload.${field}}${escapeForTemplateLiteral(site.after)}\``;
}

/**
 * Build the emitted instruction expression for a step whose splice site is the
 * reserved `${RECON_PASSWORD}` token: a backtick template literal with the
 * token replaced by `${throwawayPassword}`, the per-run credential minted by
 * {@link generateThrowawayPassword} — never the recon capture's literal
 * password, and never routed through `payload.<field>` since no caller-
 * supplied Password field exists on the applicant payload.
 */
function buildPasswordInstructionExpr(instruction: string): string {
  const site = locateSpliceSite(instruction);
  if (site === null) return JSON.stringify(instruction);
  return `\`${escapeForTemplateLiteral(site.before)}\${throwawayPassword}${escapeForTemplateLiteral(site.after)}\``;
}

/**
 * Rewrites one step instruction into the config-manifest templating form: the
 * splice site located by {@link locateSpliceSite} becomes `{{ .request.<field> }}`.
 * Unlike {@link buildStepInstructionExpr} this yields a plain manifest string,
 * not a TS expression — the runtime config-plugin resolver, not the code
 * generator, performs the splice. Reuses {@link locateSpliceSite} so this
 * emitter never lands the splice on a selector's or label's quoted span, the
 * same guarantee {@link buildStepInstructionExpr} makes.
 */
function buildManifestInstruction(instruction: string, field: string | null): string {
  if (field === null) return instruction;
  const site = locateSpliceSite(instruction);
  if (site === null) return instruction;
  return `${site.before}{{ .request.${field} }}${site.after}`;
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
 * only from the handful of flow-step splice hints.
 *
 * When the site has a direct-HTTP path (a submission flow whose `.ts` emit would
 * carry an `executeHttp`), `httpModulePath` emits a `spec.httpModule` reference
 * to a compiled module the operator drops in — the config plugin's escape hatch
 * for the imperative hot path a JSON manifest cannot express. Absent that, the
 * browser `flow` is the only execution path, and the field is omitted.
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
  /**
   * Relative path to the compiled `executeHttp` module for a site with a
   * direct-HTTP path. Emitted as `spec.httpModule`; omitted when the site is
   * browser-only.
   */
  httpModulePath?: string;
}): string {
  const {
    siteId,
    displayName,
    baseUrl,
    flowSteps,
    vocabulary,
    inputBody,
    recoveredFields,
    httpModulePath,
  } = opts;
  const payloadFieldNames = new Set<string>();

  const steps = flowSteps.map((step) => {
    const isObj = typeof step !== "string";
    const instruction = isObj ? step.step : step;
    // A config-only manifest has no compiled code to mint a throwaway credential
    // at runtime (unlike emitBrowserFlowTs's generateThrowawayPassword() splice),
    // so ${RECON_PASSWORD} is routed to an explicit "Password" request field
    // instead — the operator supplies it at call time. Either way the literal
    // token must never survive into the manifest.
    if (instruction.includes(RECON_PASSWORD_TOKEN)) {
      payloadFieldNames.add("Password");
      const rewritten = buildManifestInstruction(instruction, "Password");
      const optional = isObj ? step.optional === true : false;
      const upload = isObj ? step.upload === true : false;
      const submitStep = isObj ? step.submitStep === true : false;
      if (!optional && !upload && !submitStep) return rewritten;
      return { step: rewritten, optional, upload, submitStep };
    }
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
      ...(httpModulePath ? { httpModule: httpModulePath } : {}),
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
  /** CSS selector of a cross-origin `<iframe>` the flow's target elements live
   * inside, from the recon flow file's object-form `frameSelector`. Matches
   * `spec.flow.frameSelector` in `src/plugins/config-plugin.ts` so a generated
   * plugin keeps the same cross-origin iframe capability the recon flow used.
   * Omitted (undefined) preserves today's main-frame-only generation. */
  frameSelector?: string;
}): { code: string; payloadFieldNames: Set<string> } {
  const {
    siteId,
    pascal,
    flowSteps,
    isSubmissionFlow,
    hasMultipartStep = false,
    vocabulary,
    frameSelector,
  } = opts;

  const payloadFieldNames = new Set<string>();
  const hasUploadStep = flowSteps.some((s) => typeof s !== "string" && s.upload === true);
  let usesThrowawayPassword = false;

  const stepLiterals = flowSteps.map((step) => {
    const isObj = typeof step !== "string";
    const instruction = isObj ? step.step : step;
    // ${RECON_PASSWORD} is reserved-tooling, not a domain-vocabulary concern —
    // it names a credential the recon capture needed to authenticate, not a
    // piece of the caller's applicant identity, so it never reaches
    // resolveStepPayloadField/vocabulary and never routes through
    // payload.<field>. It gets a generated throwaway credential instead.
    if (instruction.includes(RECON_PASSWORD_TOKEN)) {
      usesThrowawayPassword = true;
      const instructionExpr = buildPasswordInstructionExpr(instruction);
      const optional = isObj ? step.optional === true : false;
      const upload = isObj ? step.upload === true : false;
      const submitStep = isObj ? step.submitStep === true : false;
      return `  { instruction: ${instructionExpr}, optional: ${optional}, upload: ${upload}, submitStep: ${submitStep} },`;
    }
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
      : "  // TODO: no flow steps were parsed. Re-run recon-browser with a --flow\n" +
        "  // that walks the apply wizard, then regenerate — recon:generate reads\n" +
        "  // the captured steps from the run dir, it does not write a flow file here.";

  // Wire an uploadFixture from the payload's Resume/ResumeFilename/
  // ResumeContentType fields ONLY when the contract actually carries them
  // (hasMultipartStep) AND the flow uploads. When a flow has an upload step but
  // the captures weren't detected as multipart (e.g. a GraphQL site where
  // multipart detection is dropped), those payload fields don't exist yet — emit
  // a null + TODO so the generated module still typechecks; the operator adds
  // the multipart contract fields and wires the fixture during hand-finish.
  const uploadFixtureExpr =
    hasUploadStep && hasMultipartStep
      ? `{
    buffer: Buffer.from(payload.Resume),
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

import { buildAnthropicClient, buildRephraseModel } from "${ENGINE_PKG}/lib/llm/anthropic-client";
import { getLogger } from "${ENGINE_PKG}/lib/logging";${usesThrowawayPassword ? `\nimport { generateThrowawayPassword } from "${ENGINE_PKG}/lib/random";` : ""}
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
${usesThrowawayPassword ? "\n  // Minted once per run — the flow needs a credential to authenticate, but\n  // there is no caller-supplied Password field on the payload to splice.\n  const throwawayPassword = generateThrowawayPassword();\n" : ""}
  const FLOW_STEPS: HealingFlowStep[] = [
${flowStepsBlock}
  ];

  // buildAnthropicClient() feeds the judge techniques and is null on a
  // Bedrock-only deployment; buildRephraseModel() feeds attempt-5's rephrase
  // and resolves to the Bedrock-backed model in that case, so the cascade
  // keeps full rephrase parity regardless of deployment shape.
  await runHealingFlow({
    stagehand,
    page,
    steps: FLOW_STEPS,
    logger,
    anthropic: buildAnthropicClient(),
    rephraseModel: buildRephraseModel(),
    uploadFixture: ${uploadFixtureExpr},${frameSelector !== undefined ? `\n    frameSelector: ${JSON.stringify(frameSelector)},` : ""}
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
 * Absent `--vocabulary`, no splicing happens: the engine cannot know what any
 * site's forms mean, so it never guesses.
 */
async function resolveVocabulary(specifier: string): Promise<ReconVocabulary> {
  if (!specifier) return EMPTY_VOCABULARY;

  const vocabulary = await loadReconVocabulary(specifier, process.cwd());
  logger.info(
    `vocabulary: ${specifier === VOCABULARY_NONE ? "none (splicing disabled)" : `${vocabulary.table.length} row(s) from ${specifier}`}`
  );
  return vocabulary;
}

/**
 * Resolves the form-schema for this run and reports which one is in play.
 *
 * The engine carries no vendor's wire format (issue #57): a consumer whose ATS
 * exposes a form definition declares its keys with `--form-schema`. Absent one
 * (or `--form-schema none`), form-key recovery does not run and the generator
 * recovers nothing from ATS-shaped responses — the same "absence means none"
 * discipline `--vocabulary` uses.
 */
async function resolveFormSchema(specifier: string): Promise<ReconFormSchema | null> {
  if (!specifier) return null;
  const formSchema = await loadReconFormSchema(specifier, process.cwd());
  logger.info(
    `form-schema: ${specifier === FORM_SCHEMA_NONE ? "none (no ATS form recovery)" : `custom keys from ${specifier}`}`
  );
  return formSchema;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let siteId = "";
  let force = false;
  let emit: "ts" | "config" = "ts";
  let vocabularySpecifier = "";
  let formSchemaSpecifier = "";
  let runDir: string | undefined;
  let allowEmptyCapture = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--site-id" && args[i + 1]) siteId = args[++i]!;
    else if (args[i] === "--vocabulary" && args[i + 1]) vocabularySpecifier = args[++i]!;
    else if (args[i] === "--form-schema" && args[i + 1]) formSchemaSpecifier = args[++i]!;
    else if (args[i] === "--run-dir" && args[i + 1]) runDir = args[++i]!;
    else if (args[i] === "--force") force = true;
    else if (args[i] === "--allow-empty-capture") allowEmptyCapture = true;
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

  const runRoot = resolveLatestReconRunRoot(runDir);
  logger.info(`reading recon artifacts from ${runRoot}`);
  const capturesDir = join(runRoot, "graphql");
  const replaysDir = join(runRoot, "replays");
  const auxDir = join(runRoot, "aux");

  const captures = readJsonDir<Capture>(capturesDir);
  // No captures means recon-browser walked no flow (or ran with --allow-empty-flow):
  // every downstream derivation (baseUrl, actionSteps, isSubmissionFlow) reads
  // `captures`, so an empty graphql/ silently yields a skeleton plugin whose
  // "submission flow" is fabricated from landing-page chrome. Fail fast. `replays`
  // is written 1:1 downstream of captures, so it can never rescue an empty capture
  // set — captures is the sole load-bearing signal.
  if (captures.length === 0 && !allowEmptyCapture) {
    logger.error(
      `recon-generate: run dir ${runRoot} has no captures — nothing to generate a plugin from (did recon-browser run without a --flow?). Pass --allow-empty-capture to override.`
    );
    process.exit(1);
  }
  const replays = readJsonDir<ReplayResult>(replaysDir, [
    "rate-limit.json",
    "introspection-schema.json",
  ]);
  const rateLimits = (() => {
    try {
      return JSON.parse(
        readFileSync(join(replaysDir, "rate-limit.json"), "utf8")
      ) as RateLimitFinding[];
    } catch {
      return [] as RateLimitFinding[];
    }
  })();

  const auxFiles = (() => {
    try {
      return readdirSync(auxDir)
        .filter((f) => f.endsWith(".json"))
        .sort();
    } catch {
      return [] as string[];
    }
  })();

  const { flowSteps, frameSelector, submitEndpointPattern, submitBodyPattern } = (() => {
    const flowFile = `src/sites/${siteId}/recon-flow.json`;
    try {
      const raw: unknown = JSON.parse(readFileSync(flowFile, "utf8"));
      if (Array.isArray(raw))
        return {
          flowSteps: raw as FlowStepInput[],
          frameSelector: undefined,
          submitEndpointPattern: null,
          submitBodyPattern: null,
        };
      if (
        raw !== null &&
        typeof raw === "object" &&
        "steps" in raw &&
        Array.isArray((raw as { steps: unknown }).steps)
      ) {
        const obj = raw as {
          steps: FlowStepInput[];
          frameSelector?: string;
          submitEndpointPattern?: string;
          submitBodyPattern?: string;
        };
        return {
          flowSteps: obj.steps,
          frameSelector: obj.frameSelector,
          submitEndpointPattern: obj.submitEndpointPattern ?? null,
          submitBodyPattern: obj.submitBodyPattern ?? null,
        };
      }
      return {
        flowSteps: [] as string[],
        frameSelector: undefined,
        submitEndpointPattern: null,
        submitBodyPattern: null,
      };
    } catch {
      return {
        flowSteps: [] as string[],
        frameSelector: undefined,
        submitEndpointPattern: null,
        submitBodyPattern: null,
      };
    }
  })();

  // Flow-declared signals that isolate the submission POSTs from same-origin
  // page chrome. Threaded into action-sequence extraction and header derivation
  // so both draw from the real submission, not incidental widget/chatbot POSTs.
  const submitPatterns: SubmitPatterns = {
    endpoint: submitEndpointPattern,
    body: submitBodyPattern,
  };

  // Resolved once and threaded down, never captured into a module const: a
  // module-level const would freeze at import time, so an env var set after
  // module load would be silently inert for anyone reading it that way.
  const vocabulary = await resolveVocabulary(vocabularySpecifier);
  // Consumer-supplied wire keys for ATS form-schema recovery, or null. When
  // null the recovery functions no-op — the engine hardcodes no vendor format.
  const formSchema = await resolveFormSchema(formSchemaSpecifier);

  const pascal = toPascalCase(siteId);
  const baseUrl = deriveBaseUrl(captures);
  const baseHeaders = deriveRequestHeaders(captures, replays, baseUrl, submitPatterns);
  const minTime = deriveMinTime(rateLimits);
  const safeRps = rateLimits.find((f) => f.safeRps !== null)?.safeRps ?? Math.floor(1000 / minTime);
  const responseBody = firstSuccessfulReplayBody(replays);
  const gql = isGraphQL(captures);
  // Hoisted so both the primary-operation gate below and rawActionCaptures
  // (further down) read the same computed sequence instead of calling the
  // extractor twice.
  const graphqlActionSequence = gql ? extractGraphQLActionSequence(captures, submitPatterns) : [];
  const isReadOnlyFlow = !flowSteps.some(
    (step) => typeof step !== "string" && step.submitStep === true
  );
  const primaryGraphQLOperation =
    gql && isReadOnlyFlow && graphqlActionSequence.length === 0
      ? selectPrimaryGraphQLOperation(captures, flowSteps, vocabulary)
      : null;
  const gqlQuery = primaryGraphQLOperation?.capture.query ?? firstGraphQLQuery(captures);
  const endpointPath = primaryGraphQLOperation?.endpointPath ?? firstEndpointPath(captures);

  // Detect a multi-step submission flow (transactional sites like apply forms,
  // checkout, etc.). When the action sequence has 2+ POSTs, switch the
  // contract template to emit a state-threaded executeHttp.
  //
  // Selection precedence: (A) the authoritative submit-manifest recon-browser
  // wrote from the verified submission; else (B/C) pattern/heuristic extraction.
  // The manifest is the only signal that separates a submission POST from a
  // page-chrome POST sharing its URL, so it normally wins when present — but
  // a manifest built from a single flow-declared submit step cannot represent
  // a wizard whose every section saves independently, so it is only trusted
  // when it isn't a strict undercount of what the same captures' own
  // heuristic extraction finds.
  const patternedHeuristicActionCaptures = gql
    ? graphqlActionSequence
    : collapseRedundantPatches(extractActionSequence(captures, submitPatterns));
  // The same undercount hazard applies one layer below the manifest: a
  // flow-declared submitEndpointPattern that matches only one section's URL
  // (the natural way to describe "the button that finishes the wizard")
  // filters the heuristic sequence down to that one capture even though the
  // same captures, read without the pattern, show every section saving
  // independently. A pattern that undercounts what the unfiltered heuristic
  // finds is therefore not trusted either — it falls back to the richer,
  // unfiltered sequence instead of collapsing a real multi-call flow into
  // the generic single-endpoint fallback.
  const unfilteredHeuristicActionCaptures =
    submitPatterns.endpoint === null && submitPatterns.body === null
      ? patternedHeuristicActionCaptures
      : gql
        ? extractGraphQLActionSequence(captures, null)
        : collapseRedundantPatches(extractActionSequence(captures, null));
  const patternUndercounts =
    patternedHeuristicActionCaptures.length < unfilteredHeuristicActionCaptures.length;
  if (patternUndercounts) {
    logger.info(
      `submission selection: ignoring submitEndpointPattern/submitBodyPattern (${patternedHeuristicActionCaptures.length} capture(s)) as an undercount of the unfiltered heuristic action sequence (${unfilteredHeuristicActionCaptures.length} capture(s))`
    );
  }
  const heuristicActionCaptures = patternUndercounts
    ? unfilteredHeuristicActionCaptures
    : patternedHeuristicActionCaptures;
  const manifestActionCaptures = resolveManifestActionSequence(runRoot, captures);
  const manifestUndercounts =
    manifestActionCaptures !== null &&
    manifestActionCaptures.length < heuristicActionCaptures.length;
  if (manifestActionCaptures !== null && manifestUndercounts) {
    logger.info(
      `submission selection: ignoring submit-manifest.json (${manifestActionCaptures.length} capture(s)) as an undercount of the heuristic action sequence (${heuristicActionCaptures.length} capture(s))`
    );
  } else if (manifestActionCaptures !== null) {
    logger.info(
      `submission selection: using submit-manifest.json (${manifestActionCaptures.length} authoritative capture(s))`
    );
  }
  const rawActionCaptures =
    manifestActionCaptures !== null && !manifestUndercounts
      ? manifestActionCaptures
      : heuristicActionCaptures;
  // The declared submitEndpointPattern's own under-match: unlike manifestUndercounts
  // (which compares an authoritative submit-manifest.json against the heuristic
  // sequence), this compares the pattern-filtered heuristic sequence against the SAME
  // captures with no submitPatterns filter at all — the true raw non-GET 2xx non-noise
  // action set. A pattern that matches conspicuously fewer calls than that raw set is a
  // detection failure (the pattern is too narrow), not evidence the flow is read-only,
  // and per the no-silent-fallback rule must not be allowed to quietly collapse into the
  // generic single-endpoint {query} template below.
  const rawUnfilteredActionCaptures =
    submitEndpointPattern === null
      ? null
      : gql
        ? extractGraphQLActionSequence(captures, null)
        : collapseRedundantPatches(extractActionSequence(captures, null));
  // Form-schema detection runs BEFORE state-indexing so the field-id/option-id
  // UUIDs can be shielded from indexing — those UUIDs are stable schema
  // anchors that T2/T3 substitution depends on remaining literal in body
  // templates.
  const { fieldNameMap, fieldOptionsMap, allSchemaUuids } = detectFormSchemaFieldNames(
    captures,
    formSchema
  );
  // Shield ALL field-id/option-id UUIDs that appear in any schema response, not
  // just the ones that detectFormSchemaFieldNames emits a payload name for.
  // Some fields have names too long for the naming heuristic (>80 chars) and
  // would be skipped by fieldNameMap; their field-ids still need shielding
  // because they appear as anchors in the T2-substituted body templates.
  const shieldedUuids = new Set<string>(allSchemaUuids);
  // Persona identity bindings + entry-URL job coordinates — the value→payload
  // reconciliation the body emitter merges into its substitution map so nested
  // applicant fields and job context reach the caller's data instead of the
  // recon persona's. Both are site-agnostic: persona mapping comes from the
  // consumer vocabulary, job coordinates from the entry URL's own query keys.
  const personaBindings = harvestPersonaBindings(flowSteps, vocabulary, process.env);
  const entryUrlParams = extractEntryUrlParams(captures[0]?.url ?? "");
  // T4 — Phase B+C: detect a form-schema GET capture and insert it into the
  // action sequence at the position observed during recon, so the existing
  // state-threading machinery can produce its FormHistoryId / section UUIDs /
  // etc. as state values for downstream POSTs. Strip cache-buster query
  // params (recon timestamps) from the captured URL so the emitted runtime
  // fetch uses a clean template. Sites without a schema-fetch capture
  // (rawSchemaFetch === null) get unchanged behavior.
  const rawSchemaFetch =
    gql || formSchema === null ? null : detectFormSchemaFetchCapture(captures, baseUrl, formSchema);
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

  // Loud failure for a submitEndpointPattern that under-matches the raw traffic badly
  // enough to collapse the flow to the single-endpoint fallback: heuristicActionCaptures
  // is the pattern-filtered sequence (used both directly and as rawActionCaptures' floor
  // via manifestUndercounts above), so if it's this thin ONLY because the pattern itself
  // excluded real action captures the unfiltered raw set still has, emitting the generic
  // {query} template would misrepresent a genuine multi-call flow as read-only. Exit
  // rather than degrade quietly, per the no-defensive/no-silent-fallback rule.
  if (
    rawUnfilteredActionCaptures !== null &&
    !isSubmissionFlow &&
    rawUnfilteredActionCaptures.length > heuristicActionCaptures.length
  ) {
    logger.error(
      `ERROR declared submitEndpointPattern ${JSON.stringify(submitEndpointPattern)} matched only ${heuristicActionCaptures.length} of ${rawUnfilteredActionCaptures.length} raw non-GET 2xx non-noise action capture(s) — this under-match looks like a detection failure, not a read-only flow; refusing to fall back to the generic single-endpoint {query} template. Fix submitEndpointPattern in recon-flow.json to cover the real submission calls.`
    );
    process.exit(1);
  }

  // Diagnostic for the FAILURE-3 shape (a flowless recon capture): a "submission flow"
  // whose every action capture is landing-phase is almost certainly page-chrome
  // bootstrap (e.g. page-chrome `POST /widgets`) misread as an apply flow, not a walked
  // wizard. Real wizard steps carry a step-slug phase; single-endpoint search runs
  // are `length <= 1` and never reach here. We do not filter (that would delete the
  // sole search POST of legitimate `--url`-only single-endpoint runs, which is also
  // landing-phase) — we only surface the suspicious shape.
  if (isSubmissionFlow && actionCaptures.every((a) => a.capture.phase === "home")) {
    logger.warn(
      `WARN all ${actionCaptures.length} action captures are landing-phase (phase="home") — this may be page-chrome bootstrap misread as a submission flow, not a walked apply wizard; verify the recon --flow actually advanced the form`
    );
  }

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
  // Phase E: maps label-derived raw-option payload field name (e.g.
  // "AreYouOverTheAgeOf18OptionId") → recon-observed option-id UUID. Used to
  // emit `<Name>OptionId: z.string()` payload fields with TSDoc docs.
  const discoveredRawOptionFields = new Map<string, string>();
  // Phase F: keys from additional action POST bodies (beyond inputBody/r0)
  // that get parameterized. Recorded with their value type so the contract
  // emitter can add them to the payload schema with appropriate Zod types.
  const discoveredAdditionalBodyKeys = new Map<string, "string" | "number" | "boolean">();
  // Mechanism A: reconcile flow SELECT steps to submitted option codes. The
  // resolutions drive a wire-key-anchored body rewrite (label→code dropdowns);
  // i18n-only dropdowns (labels all templated, e.g. gender) fall through to the
  // existing raw-option channel so their frozen code is still parameterized.
  const { resolutions: selectResolutions, rawCodeFields } = buildSelectOptionResolutions(
    flowSteps,
    captures,
    vocabulary,
    process.env
  );
  for (const [semanticName, { code }] of rawCodeFields) {
    const fieldName = `${semanticName}Code`;
    if (!discoveredRawOptionFields.has(fieldName)) discoveredRawOptionFields.set(fieldName, code);
  }
  // Mechanism B: nested caller structures (experienceData/educationData
  // history, opaque eventData) discovered during the body emit, surfaced to the
  // contract's payload schema.
  const discoveredStructuredKeys = new Map<string, string>();
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
  // Third branch (browser-flow-only): a multi-action flow (isSubmissionFlow)
  // that crosses hosts mid-sequence (compileActionSteps' isCrossDomain — a
  // captured redirect off the original domain, e.g. an auth bounce or a
  // vendor-hosted submission step). A bare `fetch`-based executeHttp can't
  // reliably replay that: cookies/CSRF/session state minted for one origin
  // don't automatically carry to the next the way a real browser's redirect
  // handling does, so synthesizing a same-shape HTTP sequence would silently
  // drop the session boundary the recon actually walked. Per-step, this
  // already surfaces as the "cross-domain redirect detected ... likely needs
  // browser fallback for this step" TODO (see emitMultiStepExecuteHttp); at
  // the whole-flow level the honest emit is no executeHttp at all — never a
  // same-host multi-step body that quietly drops the hop, and never a
  // downgrade to the single-endpoint `{query}` branch either, since that's a
  // fabrication of its own kind for a flow that isn't a single-action
  // query/search to begin with.
  const browserFlowOnly = isSubmissionFlow && actionSteps.some((s) => s.isCrossDomain);
  const multiStepBody = browserFlowOnly
    ? undefined
    : isSubmissionFlow
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
          formSchema,
          personaBindings,
          entryUrlParams,
          shieldedUuids,
          selectResolutions,
          discoveredStructuredKeys,
          rawCodeFields
        )
      : undefined;

  const hasMultipartStep = actionSteps.some((s) => s.isMultipart);
  const headerBindings = collectHeaderBindings(actionSteps);
  // Shape inference targets the SAME call executeHttp returns — see
  // selectEffectiveResponseBody — so the two surfaces can't describe different calls.
  const effectiveResponseBody = selectEffectiveResponseBody(
    isSubmissionFlow,
    actionSteps,
    responseBody
  );

  logger.info(
    `generating plugin for ${siteId} (${gql ? "GraphQL" : browserFlowOnly ? `submission flow, ${actionSteps.length} steps, browser-flow-only (cross-domain hop detected)` : isSubmissionFlow ? `submission flow, ${actionSteps.length} steps` : "single-endpoint REST"}, baseUrl: ${baseUrl})`
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
        // A submission flow is the case where the `.ts` emit carries an
        // executeHttp hot path; point the manifest at where the operator drops
        // the compiled module rather than silently dropping the direct path.
        // Not set for the browser-flow-only branch — there is no hot path to
        // compile a module for.
        httpModulePath: isSubmissionFlow && !browserFlowOnly ? `./${siteId}.http.js` : undefined,
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
    frameSelector,
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
      gqlOperationName: primaryGraphQLOperation?.capture.operationName ?? null,
      gqlVariables: primaryGraphQLOperation?.capture.variables ?? null,
      auxFiles,
      multiStepBody,
      omitExecuteHttp: browserFlowOnly,
      inputBody,
      hasMultipartStep,
      discoveredFormFields,
      fieldOptionsMap,
      discoveredOptionFields,
      discoveredRawOptionFields,
      discoveredAdditionalBodyKeys,
      discoveredStructuredKeys,
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
      copyFileSync(join(auxDir, f), `${outDir}/fixtures/${f}`);
    }
    logger.info(`copied ${auxFiles.length} fixture(s) to ${outDir}/fixtures/`);
  }

  logger.info(
    `done — review ${outDir}/, build the package, then point BARNACLE_PLUGINS at the compiled module (no core edits required): BARNACLE_PLUGINS=./dist/sites/${siteId}/index.js pnpm start`
  );
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
