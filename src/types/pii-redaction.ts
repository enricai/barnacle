/** Allowlisted view of an inbound request body that is safe to persist. */
export interface InboundPayloadSummary {
  [key: string]: unknown;
  /** Names of the non-allowlisted keys that carried a value, never the values. */
  fieldsPresent: string[];
}
