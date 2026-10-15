/** Allowlisted view of an inbound request body that is safe to persist. */
export interface InboundPayloadSummary {
  [key: string]: unknown;
  /** Names of the non-allowlisted keys that carried a value, never the values. */
  fieldsPresent: string[];
}

/** Stagehand `variables` map: token name (without `%`) → the exact text it replaced. */
export type SensitiveVariables = Record<string, string>;

/** An instruction with its applicant values swapped for `%Name%` tokens. */
export interface TokenizedText {
  text: string;
  variables: SensitiveVariables;
}
