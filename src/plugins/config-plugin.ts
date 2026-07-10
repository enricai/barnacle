/**
 * Turns a declarative plugin manifest (JSON on disk, no per-site TypeScript)
 * into a live {@link SitePlugin} at load time. This is what makes a Barnacle
 * site loadable from configuration alone: the manifest carries the request /
 * response / extract schemas as JSON Schema and the browser flow as data, and
 * `buildConfigPlugin` synthesizes the Zod instances + `execute` function the
 * loader's `validatePluginShape` requires.
 *
 * The manifest wears the Kubernetes-style `apiVersion` / `kind` / `metadata` /
 * `spec` envelope so it reads like every other declarative object operators
 * already know, and the browser flow reuses the same `RECON_FLOW_STEP_SCHEMA` +
 * `runHealingFlow` interpreter the recon toolchain and generated plugins use —
 * this factory is the recon-generate `emitBrowserFlowTs` template made
 * data-driven instead of frozen into source.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod/v4";

import { RECON_FLOW_STEP_SCHEMA } from "@/lib/llm/schemas";
import { getLogger } from "@/lib/logging";
import { jsonSchemaToZod } from "@/plugins/json-schema-to-zod";
import { PLUGIN_API_VERSION } from "@/plugins/plugin-api-version";
import { CONFIG_PLUGIN_API_VERSION, CONFIG_PLUGIN_KIND } from "@/plugins/plugin-manifest-envelope";
import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import { navigateActivePage } from "@/scraper/navigate";
import { guardedExtract } from "@/scraper/stagehand-guard";
import type { SitePlugin, SitePluginContext, SitePluginResult } from "@/site-plugin";

/** JSON-Schema fragment as it appears verbatim in a manifest; converted to Zod at build time. */
const jsonSchemaFragment = z.record(z.string(), z.unknown());

const flowSchema = z.object({
  steps: z.array(RECON_FLOW_STEP_SCHEMA).min(1),
  submitEndpointPattern: z.string().nullish(),
  submittedStateSelectors: z.array(z.string()).optional(),
  requireSubmitEndpointMatch: z.boolean().optional(),
  advanceTransitionBodyPattern: z.string().nullish(),
  successUrlFragments: z.array(z.string()).optional(),
  successPageTitleHints: z.array(z.string()).optional(),
  ownBackendHostnames: z.array(z.string()).optional(),
  knownErrorClassPrefixes: z.array(z.string()).optional(),
  wizardExitButtonLabels: z.array(z.string()).optional(),
});

/**
 * Structural schema for a config-plugin manifest. Validated before conversion
 * so a malformed manifest fails at load with a descriptive Zod error rather
 * than a runtime crash while the plugin is servicing a request.
 */
export const CONFIG_PLUGIN_MANIFEST = z.object({
  apiVersion: z.literal(CONFIG_PLUGIN_API_VERSION),
  kind: z.literal(CONFIG_PLUGIN_KIND),
  metadata: z.object({
    siteId: z.string().min(1),
    displayName: z.string().min(1),
  }),
  spec: z.object({
    defaultBaseUrl: z.string().optional(),
    routeOverride: z.string().optional(),
    multipart: z.boolean().optional(),
    advancedStealth: z.boolean().optional(),
    taskTimeoutMs: z.number().optional(),
    request: jsonSchemaFragment,
    response: jsonSchemaFragment,
    flow: flowSchema,
    extract: z.object({
      instruction: z.string().min(1),
      schema: jsonSchemaFragment,
    }),
    httpModule: z.string().optional(),
  }),
});

export type ConfigPluginManifest = z.infer<typeof CONFIG_PLUGIN_MANIFEST>;

type ExecuteHttpFn = NonNullable<SitePlugin["executeHttp"]>;

/** Matches `{{ .request.FieldName }}` — the only interpolation form a manifest step may use. */
const TEMPLATE_PATTERN = /\{\{\s*\.request\.([A-Za-z0-9_]+)\s*\}\}/g;

/**
 * Resolves `{{ .request.X }}` references in a step instruction against the
 * validated request payload. Distinguishes two cases via `declaredFields` (the
 * request schema's property names) so an omitted *optional* field is not
 * conflated with a typo: a reference to an **undeclared** field throws (the
 * manifest is wrong), while a **declared** field the caller omitted resolves to
 * an empty string (a legitimately optional value). Values splice as inert text
 * (no expression evaluation), so there is no injection surface.
 */
function resolveTemplate(
  instruction: string,
  payload: Record<string, unknown>,
  declaredFields: Set<string>
): string {
  return instruction.replace(TEMPLATE_PATTERN, (_match, field: string) => {
    if (!declaredFields.has(field)) {
      throw new Error(`flow step references unknown request field "${field}"`);
    }
    return field in payload ? String(payload[field]) : "";
  });
}

/** Normalizes one manifest flow step (bare string or object form) into a {@link HealingFlowStep}. */
function toHealingStep(
  step: z.infer<typeof RECON_FLOW_STEP_SCHEMA>,
  payload: Record<string, unknown>,
  declaredFields: Set<string>
): HealingFlowStep {
  if (typeof step === "string") {
    return {
      instruction: resolveTemplate(step, payload, declaredFields),
      optional: false,
      upload: false,
      submitStep: false,
    };
  }
  return {
    instruction: resolveTemplate(step.step, payload, declaredFields),
    optional: step.optional,
    upload: step.upload,
    submitStep: step.submitStep,
  };
}

/**
 * Builds the resume fixture the browser flow uploads, mirroring the rule the
 * generator's `emitBrowserFlowTs` applies: only when a step uploads AND the
 * manifest declares itself multipart do the `Resume*` payload fields exist.
 */
function buildResumeFixture(
  payload: Record<string, unknown>,
  hasUploadStep: boolean,
  multipart: boolean
): { buffer: Buffer; name: string; mimeType: string } | null {
  if (!hasUploadStep || !multipart) return null;
  return {
    buffer: Buffer.from((payload.Resume as string | undefined) ?? "", "base64"),
    name: (payload.ResumeFilename as string | undefined) ?? "resume.pdf",
    mimeType: (payload.ResumeContentType as string | undefined) ?? "application/pdf",
  };
}

/**
 * Dynamically loads the optional `executeHttp` escape-hatch module a manifest
 * may reference. Kept async and separate so a browser-only manifest never pays
 * for an import it does not use, and a broken `httpModule` disables the plugin
 * via the loader's normal failure path rather than crashing the factory.
 *
 * Resolution mirrors the loader's `resolvePluginSpecifier`: a `.`/`/` specifier
 * is a filesystem path resolved against `baseDir` (so a relative `httpModule`
 * resolves against the operator's `BARNACLE_PLUGINS_DIR`, not this module's
 * location under `dist/`); anything else is a bare package name left for Node's
 * resolver.
 */
async function loadHttpModule(specifier: string, baseDir: string): Promise<ExecuteHttpFn> {
  const resolved =
    specifier.startsWith(".") || specifier.startsWith("/")
      ? pathToFileURL(path.resolve(baseDir, specifier)).href
      : specifier;
  const mod = (await import(resolved)) as Record<string, unknown>;
  const candidate = mod.executeHttp ?? mod.default;
  if (typeof candidate !== "function") {
    throw new Error(`httpModule ${specifier} must export an executeHttp function`);
  }
  return candidate as ExecuteHttpFn;
}

/**
 * Synthesizes a {@link SitePlugin} from a validated manifest. The returned
 * object satisfies the loader's `validatePluginShape` by construction: real Zod
 * schemas for `bodySchema`/`responseSchema` and a data-driven `execute` that
 * drives the manifest's flow through the shared self-healing interpreter.
 *
 * `baseDir` resolves a relative `spec.httpModule` escape-hatch path against the
 * operator's plugin directory, matching the loader's specifier resolution; it
 * defaults to `process.cwd()` for callers (e.g. tests) that build a manifest
 * without a manifest-file location.
 */
export async function buildConfigPlugin(
  raw: unknown,
  baseDir: string = process.cwd()
): Promise<SitePlugin<unknown, unknown>> {
  const manifest = CONFIG_PLUGIN_MANIFEST.parse(raw);
  const { metadata, spec } = manifest;
  const logger = getLogger({ name: `${metadata.siteId}-config-plugin` });

  const bodySchema = jsonSchemaToZod(spec.request);
  const responseSchema = jsonSchemaToZod(spec.response);
  const extractSchema = jsonSchemaToZod(spec.extract.schema);

  const executeHttp = spec.httpModule ? await loadHttpModule(spec.httpModule, baseDir) : undefined;

  const hasUploadStep = spec.flow.steps.some((s) => typeof s !== "string" && s.upload === true);
  const declaredFields = new Set(Object.keys((spec.request.properties as object) ?? {}));

  const plugin: SitePlugin<unknown, unknown> = {
    meta: {
      siteId: metadata.siteId,
      displayName: metadata.displayName,
      bodySchema,
      responseSchema,
      apiVersion: PLUGIN_API_VERSION,
      ...(spec.routeOverride !== undefined && { routeOverride: spec.routeOverride }),
      ...(spec.defaultBaseUrl !== undefined && { defaultBaseUrl: spec.defaultBaseUrl }),
      ...(spec.taskTimeoutMs !== undefined && { taskTimeoutMs: spec.taskTimeoutMs }),
      ...(spec.multipart !== undefined && { multipart: spec.multipart }),
      ...(spec.advancedStealth !== undefined && { advancedStealth: spec.advancedStealth }),
    },
    ...(executeHttp && { executeHttp }),
    async execute(
      rawPayload: unknown,
      session,
      context: SitePluginContext
    ): Promise<SitePluginResult<unknown>> {
      const payload = rawPayload as Record<string, unknown>;
      const { stagehand } = session;
      const page = await navigateActivePage(stagehand, context.baseUrl, context.metricsCollector);

      const steps = spec.flow.steps.map((s) => toHealingStep(s, payload, declaredFields));
      const anthropic = context.config.scraper.anthropicApiKey
        ? new Anthropic({ apiKey: context.config.scraper.anthropicApiKey })
        : null;

      await runHealingFlow({
        stagehand,
        page,
        steps,
        logger,
        anthropic,
        resumeFixture: buildResumeFixture(payload, hasUploadStep, spec.multipart ?? false),
        submitEndpointPattern: spec.flow.submitEndpointPattern ?? null,
        submittedStateSelectors: spec.flow.submittedStateSelectors ?? [],
        requireSubmitEndpointMatch: spec.flow.requireSubmitEndpointMatch ?? false,
        advanceTransitionBodyPattern: spec.flow.advanceTransitionBodyPattern ?? null,
        successUrlFragments: spec.flow.successUrlFragments ?? [],
        successPageTitleHints: spec.flow.successPageTitleHints ?? [],
        ownBackendHostnames: spec.flow.ownBackendHostnames ?? [],
        knownErrorClassPrefixes: spec.flow.knownErrorClassPrefixes ?? [],
        wizardExitButtonLabels: spec.flow.wizardExitButtonLabels ?? [],
      });

      const data = await guardedExtract(stagehand, spec.extract.instruction, extractSchema);
      return { data };
    },
  };

  return plugin;
}
