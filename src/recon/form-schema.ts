/**
 * Consumer-supplied form-schema that names the wire keys the generator reads out
 * of an ATS's form-definition responses (field ids, option ids, submitted values).
 *
 * A sibling to {@link @/recon/vocabulary}, not a field on it: a vocabulary matches
 * English instruction prose, this matches JSON response keys. Different inputs,
 * different validation, independent applicability — a cruise site needs a
 * vocabulary and no form-schema. Published at `@enricai/barnacle/recon/form-schema`;
 * all imports are type-only so there are zero runtime side effects.
 *
 * Why this exists (issue #57): the generator hardcoded one ATS vendor's wire
 * format in ~8 private functions. That is a claim about a *vendor's schema*, not
 * about HTTP — so the engine no longer carries any vendor's keys. A consumer
 * whose ATS exposes a form definition declares its keys with `--form-schema`;
 * absent one, form-key recovery does not run. This is the same inversion
 * `--vocabulary` already made for instruction prose.
 */

/**
 * The response-key names the generator threads into raw-body string anchors when
 * recovering an ATS form definition.
 *
 * These are *key names, not values*: each is interpolated into a
 * `"${key}":"${uuid}"` marker used to locate and substitute UUIDs in a captured
 * request body. A legal wire key like `field-id` is therefore fine — the loader
 * rejects only quotes and backslashes, which would break the marker, NOT the
 * JS-identifier rule the vocabulary uses (those keys splice into `payload.<name>`
 * code; these do not).
 */
export interface ReconFormSchema {
  /** The UUID-valued field-identity key. Anchors the substitution passes. */
  fieldIdKey: string;
  /**
   * Label/code keys, tried in order — first present wins. Lets a vendor that
   * exposes both a machine code and a human label prefer the code, as data. Must
   * be non-empty.
   */
  fieldNameKeys: string[];
  /** The options-array key on a field. */
  fieldOptionsKey: string;
  /** The option-id key, INSIDE a `fieldOptionsKey` entry. */
  optionIdKey: string;
  /** The option-label key, inside a `fieldOptionsKey` entry. */
  optionValueKey: string;
  /** The submitted free-value key (a distinct role from {@link optionValueKey}). */
  responseValueKey: string;
  /** The submitted option-reference key (distinct from the schema-side {@link optionIdKey}). */
  responseOptionIdKey: string;
}
