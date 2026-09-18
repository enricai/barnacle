/**
 * Engine-internal loader for `--value-constraints`. Like {@link @/recon/load-vocabulary},
 * deliberately NOT in the package's `exports` map: consumers author a value-constraints
 * module against the `./recon/value-constraints` type contract, and only `recon-generate`
 * ever loads one. Exporting this would publish an import-time side effect (dynamic
 * `import()` of arbitrary consumer code) as public API for no caller.
 */

import { z } from "zod/v4";

import { toErrorMessage } from "@/lib/errors";
import { resolvePluginSpecifier } from "@/plugins/discover";
import { EMPTY_VALUE_CONSTRAINTS, type ReconValueConstraints } from "@/recon/value-constraints";

/** The `--value-constraints` value that opts a site out of declaring any. */
export const VALUE_CONSTRAINTS_NONE = "none";

/** Matches the emitter's identifier rule: a field name is spliced into source as
 * `payload.<name>` in the generator's extendFields map, so anything else emits a
 * broken plugin that still generates. */
const payloadFieldNameSchema = z
  .string()
  .regex(
    /^[A-Za-z_$][A-Za-z0-9_$]*$/,
    "must be a valid JS identifier to splice into generated code"
  );

const fieldConstraintSchema = z
  .object({
    enumValues: z.array(z.string()).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .refine((v) => v.min === undefined || v.max === undefined || v.min <= v.max, {
    message: "min must not be greater than max",
  });

/**
 * Validates the shape at the boundary so a malformed declaration fails at generate
 * time with a field path, rather than silently emitting an unconstrained schema.
 */
const valueConstraintsSchema = z.record(payloadFieldNameSchema, fieldConstraintSchema);

/**
 * Loads a consumer's value-constraints module.
 *
 * Resolution reuses {@link resolvePluginSpecifier}, so `--value-constraints` accepts
 * the same specifier forms as `BARNACLE_PLUGINS`, `--vocabulary`, and `--form-schema`.
 * Export resolution matches the plugin loader's `m.valueConstraints ?? m.default ?? m`.
 *
 * Throws rather than falling back: constraints that were asked for and are broken
 * are an error, while asking for none is the caller's explicit `none`.
 */
export async function loadReconValueConstraints(
  specifier: string,
  baseDir: string
): Promise<ReconValueConstraints> {
  if (specifier === VALUE_CONSTRAINTS_NONE) return EMPTY_VALUE_CONSTRAINTS;

  const href = resolvePluginSpecifier(specifier, baseDir);
  const mod: unknown = await import(href);
  const record = mod as Record<string, unknown>;
  const raw = record.valueConstraints ?? record.default ?? mod;

  const parsed = valueConstraintsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `value-constraints module ${JSON.stringify(specifier)} does not export a valid ReconValueConstraints: ${toErrorMessage(parsed.error)}`
    );
  }
  return parsed.data;
}
