import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { z } from "zod/v4";

import type { AppConfig } from "@/config";
import { getLogger } from "@/lib/logging";
import { buildConfigPlugin } from "@/plugins/config-plugin";
import { PLUGIN_API_VERSION } from "@/plugins/plugin-api-version";
import type { SitePlugin } from "@/site-plugin";

const logger = getLogger({ name: "plugins/discover" });

/**
 * Describes the outcome of attempting to load a single plugin specifier.
 * Surfaced by `GET /v1/plugins` and emitted to startup logs.
 */
export interface PluginLoadRecord {
  /** `null` when the module failed before `meta.siteId` was readable. */
  siteId: string | null;
  displayName: string | null;
  /** Raw specifier from `BARNACLE_PLUGINS` or `"(builtin)"` for in-tree plugins. */
  specifier: string;
  /** Resolved absolute path or package entry point. `null` when resolution failed. */
  resolvedPath: string | null;
  route: string | null;
  apiVersion: string | null;
  status: "loaded" | "disabled";
  /** Present only when `status === "disabled"`. */
  reason?: string;
}

/**
 * Aggregated result of loading a set of plugin specifiers, returned by
 * `loadPlugins` and `loadAllPlugins`.
 */
export interface LoadPluginsResult {
  plugins: SitePlugin<unknown, unknown>[];
  report: PluginLoadRecord[];
}

/**
 * Statically-registered in-tree plugins. Empty by default: this engine branch
 * ships no site plugins, so operators register every plugin at runtime via
 * `BARNACLE_PLUGINS` (compiled module specifiers) or `*.plugin.json` config
 * manifests. Kept as a mutable array so tests can push a fixture builtin and so
 * a downstream branch that vendors sites in-tree can repopulate it.
 *
 * @see loadAllPlugins for how built-ins and out-of-tree plugins are composed.
 */
export const BUILTIN_SITE_PLUGINS: SitePlugin<unknown, unknown>[] = [];

/**
 * Resolves a plugin specifier to a `file://` URL string that `import()` can
 * consume. Follows the Babel plugin-resolution model:
 *
 * - Leading `.` or `/` → filesystem path resolved relative to `baseDir`.
 * - Anything else → npm package resolved via `createRequire` against
 *   `baseDir/package.json`, so the operator's local `node_modules` wins.
 *
 * Throws with the specifier and baseDir in the message when resolution fails,
 * so callers can build a descriptive disabled record without catching broadly.
 */
export function resolvePluginSpecifier(spec: string, baseDir: string): string {
  if (spec.startsWith(".") || spec.startsWith("/")) {
    return pathToFileURL(path.resolve(baseDir, spec)).href;
  }

  const req = createRequire(pathToFileURL(path.join(baseDir, "package.json")).href);
  try {
    const resolved = req.resolve(spec);
    return pathToFileURL(resolved).href;
  } catch (err) {
    throw new Error(
      `cannot resolve plugin specifier ${JSON.stringify(spec)} from baseDir ${JSON.stringify(baseDir)}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** Returns true when `s` looks like a Zod schema without relying on `instanceof`. */
function looksLikeZodSchema(s: unknown): boolean {
  return (
    typeof (s as { safeParse?: unknown })?.safeParse === "function" &&
    typeof (s as { parse?: unknown })?.parse === "function"
  );
}

const metaSchema = z
  .object({
    siteId: z.string().min(1),
    displayName: z.string().min(1),
    routeOverride: z.string().optional(),
    defaultBaseUrl: z.string().optional(),
    taskTimeoutMs: z.number().optional(),
    multipart: z.boolean().optional(),
    advancedStealth: z.boolean().optional(),
    browserbaseSessionCreateParams: z.record(z.string(), z.unknown()).optional(),
    apiVersion: z.string().optional(),
    extraRoutes: z.array(z.unknown()).optional(),
  })
  .passthrough();

/**
 * Duck-typed shape validation for an untrusted module export. Uses Zod for
 * `meta` field presence/types, but checks `bodySchema`/`responseSchema` via
 * duck-typing so plugins that bundle their own zod copy are not falsely
 * rejected.
 */
function validatePluginShape(raw: unknown): SitePlugin<unknown, unknown> {
  const obj = raw as {
    meta?: { bodySchema?: unknown; responseSchema?: unknown };
    execute?: unknown;
  };

  metaSchema.parse(obj.meta);

  if (!looksLikeZodSchema(obj.meta?.bodySchema)) {
    throw new Error("meta.bodySchema must be a Zod schema");
  }
  if (!looksLikeZodSchema(obj.meta?.responseSchema)) {
    throw new Error("meta.responseSchema must be a Zod schema");
  }
  if (typeof obj.execute !== "function") {
    throw new Error("plugin.execute must be a function");
  }

  return raw as SitePlugin<unknown, unknown>;
}

/**
 * Parses the leading integer from a semver string, e.g. `"1.2.3"` → `1`.
 * Returns `null` when the string cannot be parsed as a major version.
 */
function parseMajorVersion(version: string): number | null {
  const match = /^(\d+)/.exec(version.trim());
  return match ? parseInt(match[1] ?? "0", 10) : null;
}

/**
 * Creates a disabled `PluginLoadRecord` from minimal information. Used when
 * a plugin fails at any stage of loading.
 */
function disabledRecord(
  opts: Pick<PluginLoadRecord, "specifier" | "resolvedPath"> & {
    plugin?: SitePlugin<unknown, unknown>;
    reason: string;
  }
): PluginLoadRecord {
  const meta = opts.plugin?.meta;
  return {
    siteId: meta?.siteId ?? null,
    displayName: meta?.displayName ?? null,
    specifier: opts.specifier,
    resolvedPath: opts.resolvedPath,
    route: meta ? (meta.routeOverride ?? `/v1/${meta.siteId}/run`) : null,
    apiVersion: meta?.apiVersion ?? null,
    status: "disabled",
    reason: opts.reason,
  };
}

/**
 * Normalizes the three supported module export shapes into a single object.
 *
 * When CJS `module.exports = { plugin }` is loaded via dynamic `import()`,
 * Node exposes the entire exports object as `m.default` AND hoists named
 * exports so `m.plugin` is the actual plugin. We must resolve the `plugin`
 * named export before falling back to `default`, otherwise we'd return the
 * wrapper `{ plugin }` object which fails shape validation.
 *
 * Resolution order:
 *   1. `m.plugin` — named `{ plugin }` export (CJS or ESM)
 *   2. `m.default` — ESM default export
 *   3. `m` itself — CJS `module.exports = plugin` (no default wrapping)
 */
function normalizeExport(mod: unknown): unknown {
  const m = mod as Record<string, unknown>;
  return m.plugin ?? m.default ?? mod;
}

/**
 * Produces a raw plugin object from a resolved `file://` specifier. A `.json`
 * specifier is a declarative manifest — read, parse, and run through
 * `buildConfigPlugin` to synthesize a `SitePlugin` (no per-site TypeScript, no
 * compile step). Anything else is a compiled module `import()`ed as before. The
 * synthesized object still flows through the same `validatePluginShape` gate as
 * a module plugin, so the two sources share one validation path.
 *
 * `baseDir` is threaded into `buildConfigPlugin` so a manifest's relative
 * `spec.httpModule` escape-hatch path resolves against the operator's plugin
 * directory, consistent with how module specifiers themselves are resolved.
 */
async function loadRawPlugin(resolvedPath: string, baseDir: string): Promise<unknown> {
  if (resolvedPath.endsWith(".json")) {
    const manifest = JSON.parse(await readFile(fileURLToPath(resolvedPath), "utf8"));
    return await buildConfigPlugin(manifest, baseDir);
  }
  const mod = await import(resolvedPath);
  return normalizeExport(mod);
}

/**
 * Loads and validates a list of plugin specifiers. Each specifier is resolved,
 * imported, shape-validated, version-checked, and deduplication-checked before
 * being added to the result. Failures produce disabled records; under `strict`
 * mode the first failure re-throws immediately.
 *
 * `seenSiteIds` is mutated in place so the caller can pre-seed it with built-in
 * ids before calling this function (built-ins always win collisions).
 */
export async function loadPlugins(
  specifiers: readonly string[],
  opts: {
    baseDir: string;
    strict: boolean;
    seenSiteIds: Set<string>;
  }
): Promise<LoadPluginsResult> {
  const { baseDir, strict, seenSiteIds } = opts;
  const plugins: SitePlugin<unknown, unknown>[] = [];
  const report: PluginLoadRecord[] = [];

  for (const spec of specifiers) {
    let resolvedPath: string | null = null;
    let plugin: SitePlugin<unknown, unknown> | undefined;

    try {
      resolvedPath = resolvePluginSpecifier(spec, baseDir);

      const raw = await loadRawPlugin(resolvedPath, baseDir);

      plugin = validatePluginShape(raw);

      const meta = plugin.meta;

      if (meta.apiVersion !== undefined) {
        const pluginMajor = parseMajorVersion(meta.apiVersion);
        const coreMajor = parseMajorVersion(PLUGIN_API_VERSION);
        if (pluginMajor === null || coreMajor === null || pluginMajor !== coreMajor) {
          const reason = `apiVersion ${meta.apiVersion} incompatible with core ${PLUGIN_API_VERSION}`;
          logger.warn(`${spec}: ${reason}`);
          report.push(disabledRecord({ specifier: spec, resolvedPath, plugin, reason }));
          continue;
        }
      }

      if (seenSiteIds.has(meta.siteId)) {
        const reason = `duplicate siteId "${meta.siteId}" — already registered`;
        logger.warn(`${spec}: ${reason}`);
        report.push(disabledRecord({ specifier: spec, resolvedPath, plugin, reason }));
        continue;
      }

      seenSiteIds.add(meta.siteId);
      plugins.push(plugin);
      logger.info(`${spec}: loaded siteId "${meta.siteId}" (${PLUGIN_API_VERSION})`);
      report.push({
        siteId: meta.siteId,
        displayName: meta.displayName,
        specifier: spec,
        resolvedPath,
        route: meta.routeOverride ?? `/v1/${meta.siteId}/run`,
        apiVersion: meta.apiVersion ?? null,
        status: "loaded",
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn(`${spec}: failed to load — ${reason}`);
      report.push(disabledRecord({ specifier: spec, resolvedPath, plugin, reason }));
      if (strict) throw err;
    }
  }

  return { plugins, report };
}

/**
 * Scans `configDir` for `*.plugin.json` manifests and returns their absolute
 * paths as loader specifiers. Best-effort: an unreadable directory yields an
 * empty list with a warn log so a misconfigured `BARNACLE_PLUGINS_CONFIG_DIR`
 * never crashes boot — the same failure-isolation posture as a bad plugin.
 */
async function discoverConfigManifests(configDir: string): Promise<string[]> {
  try {
    const entries = await readdir(configDir);
    return entries
      .filter((name) => name.endsWith(".plugin.json"))
      .sort()
      .map((name) => path.resolve(configDir, name));
  } catch (err) {
    logger.warn(
      `plugin config dir ${JSON.stringify(configDir)} not scannable — ${err instanceof Error ? err.message : String(err)}`
    );
    return [];
  }
}

/**
 * Composes built-in and out-of-tree plugins into a single result. Built-ins
 * are always listed first and their `siteId`s seed the deduplication set, so
 * an out-of-tree plugin that collides with a built-in is disabled rather than
 * replacing it.
 */
export async function loadAllPlugins(cfg: AppConfig): Promise<LoadPluginsResult> {
  const builtins = BUILTIN_SITE_PLUGINS;
  const seenSiteIds = new Set(builtins.map((p) => p.meta.siteId));

  const builtinReport: PluginLoadRecord[] = builtins.map((p) => ({
    siteId: p.meta.siteId,
    displayName: p.meta.displayName,
    specifier: "(builtin)",
    resolvedPath: null,
    route: p.meta.routeOverride ?? `/v1/${p.meta.siteId}/run`,
    apiVersion: p.meta.apiVersion ?? null,
    status: "loaded" as const,
  }));

  const configManifests = cfg.plugins.configDir
    ? await discoverConfigManifests(cfg.plugins.configDir)
    : [];
  const specifiers = [...cfg.plugins.specifiers, ...configManifests];

  const { plugins, report } = await loadPlugins(specifiers, {
    baseDir: cfg.plugins.baseDir,
    strict: cfg.plugins.strict,
    seenSiteIds,
  });

  return {
    plugins: [...builtins, ...plugins],
    report: [...builtinReport, ...report],
  };
}
