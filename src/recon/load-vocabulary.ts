/**
 * Engine-internal loader for `--vocabulary`. Deliberately NOT in the package's
 * `exports` map: consumers author a vocabulary against the `./recon/vocabulary`
 * type contract, and only `recon-generate` ever loads one. Exporting this would
 * publish an import-time side effect (dynamic `import()` of arbitrary consumer
 * code) as public API for no caller.
 */

import { z } from "zod/v4";

import { toErrorMessage } from "@/lib/errors";
import { resolvePluginSpecifier } from "@/plugins/discover";
import { EMPTY_VOCABULARY, type ReconVocabulary } from "@/recon/vocabulary";

/** The `--vocabulary` value that opts a site out of splicing entirely. */
export const VOCABULARY_NONE = "none";

/**
 * Rejects `g`/`y` regexes, which are a correctness hazard here rather than a
 * style preference: `RegExp.prototype.test` advances `lastIndex` on a stateful
 * regex, so the generator matches each pattern against many instructions and
 * every other call returns false. A `/g` exclusion therefore misses half the
 * steps it exists to protect — e.g. `[/signature/gi]` lets the applicant's real
 * name splice into a signature field on alternate matches. Zod cannot save us
 * downstream: it passes the RegExp through by identity, `lastIndex` included.
 */
const regexSchema = z.custom<RegExp>((v) => v instanceof RegExp && !v.global && !v.sticky, {
  message: "expected a RegExp literal without the g or y flag (they make .test() stateful)",
});

/** Mirrors the emitter's identifier rule: a field name is spliced into source as
 * `payload.<name>` / `{{ .request.<name> }}`, so anything else emits a broken
 * plugin that still generates and still typechecks. */
const payloadFieldNameSchema = z
  .string()
  .regex(
    /^[A-Za-z_$][A-Za-z0-9_$]*$/,
    "must be a valid JS identifier to splice into generated code"
  );

/**
 * Validates the shape at the boundary so a malformed preset fails at generate
 * time with a field path, rather than silently resolving every step to null and
 * emitting a plugin that ignores the caller's identity.
 */
const vocabularySchema = z.object({
  subject: regexSchema,
  exclusions: z.array(regexSchema),
  table: z.array(z.tuple([regexSchema, payloadFieldNameSchema])),
});

/**
 * Loads a consumer's vocabulary module.
 *
 * Resolution reuses {@link resolvePluginSpecifier}, so `--vocabulary` accepts the
 * same specifier forms as `BARNACLE_PLUGINS` (relative path or package name) and
 * consumers learn one rule instead of two. Export resolution mirrors the plugin
 * loader's `m.vocabulary ?? m.default ?? m`, since a named-only export failing
 * silently is a known foot-gun in this codebase.
 *
 * Throws rather than falling back: a vocabulary that was asked for and is broken
 * is an error, while asking for nothing is the caller's explicit `none`.
 */
export async function loadReconVocabulary(
  specifier: string,
  baseDir: string
): Promise<ReconVocabulary> {
  if (specifier === VOCABULARY_NONE) return EMPTY_VOCABULARY;

  const href = resolvePluginSpecifier(specifier, baseDir);
  const mod: unknown = await import(href);
  const record = mod as Record<string, unknown>;
  const raw = record.vocabulary ?? record.default ?? mod;

  const parsed = vocabularySchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `vocabulary module ${JSON.stringify(specifier)} does not export a valid ReconVocabulary: ${toErrorMessage(parsed.error)}`
    );
  }
  return parsed.data;
}
