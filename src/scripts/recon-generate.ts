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
    const fields = entries
      .map(([k, v]) => `${inner}${JSON.stringify(k)}: ${inferZodSchema(v, depth + 1, inner)}`)
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
  } = opts;

  const responseSchemaExpr = inferZodSchema(responseBody);
  const headersLiteral = Object.entries(baseHeaders)
    .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`)
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

  const executeHttpBody = gql
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

const ${pascal}PayloadSchema = z.object({
  query: z.string().min(1),
});

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
    const raw = await run${pascal}BrowserFlow(session.stagehand, context.baseUrl, payload.query);
    return { data: raw as ${pascal}Response };
  },
};
`;
}

function emitBrowserFlowTs(opts: {
  siteId: string;
  pascal: string;
  baseUrl: string;
  flowSteps: string[];
}): string {
  const { siteId, pascal, flowSteps } = opts;

  const actCalls =
    flowSteps.length > 0
      ? flowSteps.map((step) => `  await stagehand.act(${JSON.stringify(step)});`).join("\n")
      : `  // TODO: add flow steps from src/sites/${siteId}/recon-flow.json`;

  return `/**
 * Generated by recon-generate.ts — Stagehand browser fallback for ${siteId}.
 * Core invokes this automatically when executeHttp throws HttpSchemaError or
 * HttpBotChallengeError. Update the flow steps and extract schema as needed.
 */

import type { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod/v4";

import type { ${pascal}Response } from "@/sites/${siteId}/contract";

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
  query: string
): Promise<${pascal}Response> {
  const page = await stagehand.context.awaitActivePage();

  await page.goto(baseUrl, { waitUntil: "networkidle" });

${actCalls}

  const result = await stagehand.extract(
    \`extract results matching query: \${query}\`,
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
      return JSON.parse(readFileSync(flowFile, "utf8")) as string[];
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

  logger.info(`generating plugin for ${siteId} (${gql ? "GraphQL" : "REST"}, baseUrl: ${baseUrl})`);

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
      responseBody,
      gql,
      gqlQuery,
      endpointPath,
      auxFiles,
    })
  );
  logger.info(`wrote ${outDir}/contract.ts`);

  writeFileSync(
    `${outDir}/flows/browser-flow.ts`,
    emitBrowserFlowTs({ siteId, pascal, baseUrl, flowSteps })
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
