/**
 * Known ATS form-label/automation-id vocabulary keyed by the canonical
 * field name it should resolve to. Both free-form human labels ("Mobile
 * Phone") and camelCase automation ids ("phoneNumber") are normalized to
 * the same lookup key, so a single table covers both vocabularies.
 */
const ATS_FIELD_VOCABULARY: Record<string, string[]> = {
  Phone: ["mobile phone", "phone number", "phone", "cell phone"],
  AddressLine: ["address line 1", "address line", "street address"],
  PostalCode: ["zip", "zip code", "postal code"],
  FirstName: ["legal first name", "first name", "given name"],
  LastName: ["legal last name", "last name", "surname", "family name"],
};

const NORMALIZED_LOOKUP: Map<string, string> = new Map(
  Object.entries(ATS_FIELD_VOCABULARY).flatMap(([canonical, synonyms]) =>
    synonyms.map((synonym) => [normalizeAtsLabel(synonym), canonical]),
  ),
);

/**
 * Splits camelCase and letter-digit boundaries and collapses punctuation so
 * that human labels ("Mobile Phone") and automation ids ("phoneNumber")
 * converge on the same lookup key.
 */
function normalizeAtsLabel(label: string): string {
  return label
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Resolves an ATS-observed form-label or automation-id to the canonical
 * field name callers already use, so no code path needs to hand-roll its
 * own label matching. Returns null when the vocabulary is unrecognized.
 */
export function resolveCanonicalAtsFieldName(observedLabel: string): string | null {
  const normalized = normalizeAtsLabel(observedLabel);
  if (normalized === "") return null;
  return NORMALIZED_LOOKUP.get(normalized) ?? null;
}
