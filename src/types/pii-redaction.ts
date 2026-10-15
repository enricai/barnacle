/**
 * How a plugin's request-body fields are treated by redaction and telemetry,
 * declared by the plugin (`SitePluginMeta.redaction`) because only it knows
 * what its fields mean. Keys are top-level body keys; a key's rule applies to
 * every string nested under it. Any key the policy does not list is redacted
 * as an exact literal — unknown fields stay protected by default.
 */
export interface RedactionPolicy {
  /** Not sensitive, and persisted verbatim in submission telemetry (join/attribution ids). */
  persistKeys?: readonly string[];
  /** Not sensitive: never scrubbed from output, but not persisted either. */
  publicKeys?: readonly string[];
  /** Never matched: binary or encoded content that cannot appear as text. */
  skipKeys?: readonly string[];
  /** Matched case-insensitively on word boundaries — values sites and LLMs re-case. */
  wordKeys?: readonly string[];
  /** Matched by their digits in any formatting (phone numbers, national ids, codes). */
  digitKeys?: readonly string[];
}

/** Allowlisted view of a request body that is safe to persist. */
export interface InboundPayloadSummary {
  [key: string]: unknown;
  /** Names of the non-persisted keys that carried a value, never the values. */
  fieldsPresent: string[];
}
