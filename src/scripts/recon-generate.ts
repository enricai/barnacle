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
function inferZodSchema(value: unknown, depth = 0, indent = ""): string {
  if (depth > 4) return "z.unknown()";
  if (value === null) return "z.null()";
  if (typeof value === "string") return "z.string()";
  if (typeof value === "number") return "z.number()";
  if (typeof value === "boolean") return "z.boolean()";
  if (Array.isArray(value)) {
    const item = value.length > 0 ? inferZodSchema(value[0], depth + 1, indent) : "z.unknown()";
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
          `${inner}${isValidJsIdentifier(k) ? k : JSON.stringify(k)}: ${inferZodSchema(v, depth + 1, inner)}`
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

  const relevantCaptures = captures.filter((c) => {
    try {
      const u = new URL(c.url);
      return successfulUrls.has(`${u.origin}${u.pathname}`);
    } catch {
      return false;
    }
  });

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

/** Minimum length for a string leaf to be indexed as a potential state value.
 * Shorter strings (1-7 chars) are rarely meaningful auth tokens / IDs and
 * inflate the index without contributing to state threading. */
const MIN_STATE_VALUE_LENGTH = 8;

/** Maximum length to guard against indexing massive blobs (HTML fragments,
 * embedded base64 images, etc.) that aren't candidates for state threading. */
const MAX_STATE_VALUE_LENGTH = 256;

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
 */
function indexStateValues(captures: Capture[]): Map<string, StateValue> {
  const index = new Map<string, StateValue>();
  for (let i = 0; i < captures.length; i++) {
    const c = captures[i]!;
    if (c.responseBody === undefined || c.responseBody === null) continue;
    for (const { value, path } of walkStringLeaves(c.responseBody)) {
      if (value.length < MIN_STATE_VALUE_LENGTH) continue;
      if (value.length > MAX_STATE_VALUE_LENGTH) continue;
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
function interpolateStateValues(template: string, priorSteps: ActionStep[]): string {
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

  const sorted = [...varNameByValue.entries()].sort((a, b) => b[0].length - a[0].length);
  let result = template;
  for (const [value, varName] of sorted) {
    result = result.split(value).join("${" + varName + "}");
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
function emitMultiStepExecuteHttp(actions: ActionStep[]): string {
  interface Rendered {
    url: string;
    method: string;
    headersExpr: string;
    bodyArg: string;
  }

  // Pass 1: render every step's emitted strings; collect referenced var names.
  const rendered: Rendered[] = [];
  for (let i = 0; i < actions.length; i++) {
    const step = actions[i]!;
    const cap = step.capture;
    const prior = actions.slice(0, i);
    const url = interpolateStateValues(cap.url, prior);
    const bodyTemplate = cap.requestPostData
      ? interpolateStateValues(cap.requestPostData, prior)
      : "";

    const perCallHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(cap.requestHeaders)) {
      const lower = k.toLowerCase();
      if (lower === "api-token" || lower === "authorization") {
        perCallHeaders[k] = interpolateStateValues(v, prior);
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
  // Multipart steps emit their URL/body as TODO comments rather than executable
  // code, so their `${name}` references don't count toward usage — skip them.
  const referencedNames = new Set<string>();
  for (let i = 0; i < rendered.length; i++) {
    if (actions[i]!.isMultipart) continue;
    const r = rendered[i]!;
    for (const haystack of [r.url, r.headersExpr, r.bodyArg]) {
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
      const lhs = bindResponse ? `const ${step.varName} = ` : "";
      lines.push(
        `    // TODO: multipart upload — recon-browser did not capture binary body.`,
        `    //       Implement by constructing a FormData with the resume buffer and POSTing to:`,
        `    //       \`${r.url}\``,
        `    //       Expected response: ${JSON.stringify(
          summariseResponseShape(cap.responseBody)
        )}`,
        `    ${lhs}await uploadMultipartTODO_${step.varName}();`
      );
    } else {
      const lhs = bindResponse ? `const ${step.varName} = (await ` : "await ";
      const rhsSuffix = bindResponse ? `)) as Record<string, unknown>;` : `);`;
      lines.push(`    ${lhs}httpClient(\`${r.url}\`, {`);
      lines.push(`      method: ${JSON.stringify(r.method)},`);
      const joined = [r.headersExpr, r.bodyArg].filter((s) => s !== "").join(" ");
      if (joined !== "") {
        lines.push(`      ${joined}`);
      }
      lines.push(`    }${rhsSuffix}`);
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
  } = opts;

  // Multi-step plugins thread responses through many different shapes that a
  // single Zod schema can't cover — use z.unknown() so each per-step access
  // compiles cleanly. Single-endpoint plugins keep the inferred schema.
  const responseSchemaExpr = multiStepBody ? `z.unknown()` : inferZodSchema(responseBody);
  const payloadSchemaExpr = inputBody
    ? inferZodSchema(inputBody)
    : `z.object({\n  query: z.string().min(1),\n})`;
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
    defaultBaseUrl: ${JSON.stringify(baseUrl)},
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

  const result = await stagehand.extract(
    ${isSubmissionFlow ? `\`drove the ${siteId} submission flow for payload \${JSON.stringify(payload)}\`` : `\`extract results matching query: \${payload.query}\``},
    ${pascal}BrowserSchema
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

  const multiStepBody = isSubmissionFlow ? emitMultiStepExecuteHttp(actionSteps) : undefined;
  const inputBody = isSubmissionFlow
    ? (() => {
        try {
          return JSON.parse(actionSteps[0]!.capture.requestPostData ?? "null") as unknown;
        } catch {
          return null;
        }
      })()
    : undefined;
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
