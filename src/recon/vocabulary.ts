/**
 * Consumer-supplied vocabulary that teaches the generator which flow-step
 * instructions carry the caller's data.
 *
 * Lives outside `src/scripts/` because it is an engine-level contract consumers
 * implement — published at `@enricai/barnacle/recon/vocabulary` — not a script
 * internal. Follows `site-plugin.ts`'s discipline: all imports are type-only, so
 * there are zero runtime side effects and it is safe to import from any layer.
 *
 * Why this exists: deciding that "Fill in the First Name field with 'Reginald'"
 * should splice the caller's `FirstName` is a claim about a *domain*, not about
 * HTTP. The engine used to hardcode a recruiting table, which silently mis-fired
 * on every other domain — a cruise site's "Select the departure port from the
 * Country dropdown" became `${payload.Country}`. The engine cannot know what a
 * site's forms mean, so it no longer guesses: the repo that owns the domain
 * declares the vocabulary and passes it with `--vocabulary`.
 */

/**
 * The domain vocabulary the generator matches flow-step instructions against.
 *
 * Order is load-bearing in {@link ReconVocabulary.table}: the first matching row
 * wins, so more-specific labels must precede broader ones (`street address`
 * before `city`). This is why the vocabulary is a JS module and not JSON — the
 * regexes stay real regexes, the array order survives, and the whole thing is
 * type-checked at the consumer.
 *
 * Every regex must be free of the `g` and `y` flags, and every table field name
 * must be a valid JS identifier; the loader rejects both. A stateful regex would
 * match only every other instruction (`.test()` advances `lastIndex`), and a
 * non-identifier field name emits `payload.<name>` as a syntax error.
 */
export interface ReconVocabulary {
  /**
   * Matches instructions that name *whose* data fills the field (e.g. "…select
   * the test candidate's state").
   *
   * This is the semantic gate, and the reason the generator stopped being wrong
   * on non-ATS sites. A step phrased around a dropdown carries no quoted constant
   * to replace, so a label match alone cannot tell "the candidate's state" (fill
   * it with the caller's data) from "the departure port" (a search facet that
   * happens to say Country). Naming the subject is what distinguishes them.
   */
  subject: RegExp;
  /**
   * Instructions that must never splice even when a table row matches — a
   * reference contact's name, an employment-history row, a screening question
   * whose text happens to contain a field label. Checked before {@link table}.
   */
  exclusions: RegExp[];
  /** Ordered label→payload-field rows. First match wins. */
  table: Array<[RegExp, string]>;
}

/**
 * A vocabulary that matches nothing, for sites whose flows carry no caller data
 * (read-only inventory, search, pricing).
 *
 * `subject` is the never-matching `/(?!)/` rather than an empty RegExp: `new
 * RegExp("")` matches every string, which would silently re-open the exact
 * false-splice this type exists to prevent.
 */
export const EMPTY_VOCABULARY: ReconVocabulary = {
  subject: /(?!)/,
  exclusions: [],
  table: [],
};
