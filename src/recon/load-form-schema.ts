/**
 * Engine-internal loader for `--form-schema`. Like {@link @/recon/load-vocabulary},
 * deliberately NOT in the package's `exports` map: consumers author a form-schema
 * against the `./recon/form-schema` type contract, and only `recon-generate` ever
 * loads one. Exporting this would publish an import-time side effect (dynamic
 * `import()` of arbitrary consumer code) as public API for no caller.
 */

import { z } from "zod/v4";

import { toErrorMessage } from "@/lib/errors";
import { resolvePluginSpecifier } from "@/plugins/discover";
import type { ReconFormSchema } from "@/recon/form-schema";

/** The `--form-schema` value that opts a site out of form-key recovery entirely. */
export const FORM_SCHEMA_NONE = "none";

/**
 * Wire keys interpolate into `"${key}":"${uuid}"` markers, not into code, so the
 * rule is NOT the vocabulary's JS-identifier rule: a legal response key like
 * `field-id` must be accepted. Reject only what would break the marker — an empty
 * key (matches every field), or a quote/backslash (escapes the JSON string anchor).
 */
const wireKeySchema = z
  .string()
  .min(1, "wire key must be non-empty")
  .regex(/^[^"\\]+$/, "wire key must not contain a quote or backslash (it anchors a JSON string)");

/**
 * Validates the shape at the boundary so a malformed preset fails at generate
 * time with a field path, rather than silently recovering no form fields and
 * emitting a plugin that ignores the site's option data.
 */
const formSchemaSchema = z.object({
  fieldIdKey: wireKeySchema,
  fieldNameKeys: z.array(wireKeySchema).min(1, "fieldNameKeys must list at least one key"),
  fieldOptionsKey: wireKeySchema,
  optionIdKey: wireKeySchema,
  optionValueKey: wireKeySchema,
  responseValueKey: wireKeySchema,
  responseOptionIdKey: wireKeySchema,
});

/**
 * Loads a consumer's form-schema module.
 *
 * Resolution reuses {@link resolvePluginSpecifier}, so `--form-schema` accepts the
 * same specifier forms as `BARNACLE_PLUGINS` and `--vocabulary`. Export resolution
 * mirrors the plugin loader's `m.formSchema ?? m.default ?? m`. The
 * {@link FORM_SCHEMA_NONE} sentinel returns `null` (not an empty struct — see the
 * form-schema module for why), the shape for "this site has no ATS form data."
 *
 * Throws rather than falling back: a form-schema that was asked for and is broken
 * is an error, while asking for nothing is the caller's explicit `none`.
 */
export async function loadReconFormSchema(
  specifier: string,
  baseDir: string
): Promise<ReconFormSchema | null> {
  if (specifier === FORM_SCHEMA_NONE) return null;

  const href = resolvePluginSpecifier(specifier, baseDir);
  const mod: unknown = await import(href);
  const record = mod as Record<string, unknown>;
  const raw = record.formSchema ?? record.default ?? mod;

  const parsed = formSchemaSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `form-schema module ${JSON.stringify(specifier)} does not export a valid ReconFormSchema: ${toErrorMessage(parsed.error)}`
    );
  }
  return parsed.data;
}
