/**
 * Known ATS form-label/automation-id vocabulary keyed by the canonical
 * field name it should resolve to. Both free-form human labels ("Mobile
 * Phone") and camelCase automation ids ("phoneNumber") are normalized to
 * the same lookup key, so a single table covers both vocabularies.
 */
const ATS_FIELD_VOCABULARY: Record<string, string[]> = {
  Phone: [
    "mobile phone",
    "mobile phone number",
    "mobile number",
    "mobile",
    "phone number",
    "phone no",
    "phone",
    "cell phone",
    "cell phone number",
    "cell number",
    "cell",
    "telephone",
    "telephone number",
    "primary phone",
    "primary phone number",
    "contact phone",
    "contact phone number",
    "contact number",
    "home phone",
  ],
  AddressLine: [
    "address line 1",
    "address line one",
    "address line",
    "address 1",
    "address",
    "street address",
    "street address 1",
    "street address line 1",
    "street address line",
    "street",
    "street 1",
    "home address",
    "mailing address",
    "residential address",
    "current address",
    "primary address",
  ],
  PostalCode: ["zip", "zip code", "postal code"],
  FirstName: ["legal first name", "first name", "given name"],
  LastName: ["legal last name", "last name", "surname", "family name"],
};

const NORMALIZED_LOOKUP: Map<string, string> = new Map(
  Object.entries(ATS_FIELD_VOCABULARY).flatMap(([canonical, synonyms]) =>
    synonyms.map((synonym) => [normalizeAtsLabel(synonym), canonical])
  )
);

const PHONE_KEY_WORDS = new Set(["phone", "mobile", "cell", "cellphone", "telephone", "tel"]);
const PHONE_QUALIFIER_WORDS = new Set([
  "number",
  "no",
  "num",
  "primary",
  "home",
  "contact",
  "personal",
  "main",
  "preferred",
  "daytime",
  "1",
  "one",
]);
const ADDRESS_KEY_WORDS = new Set(["address", "addr", "street"]);
const ADDRESS_QUALIFIER_WORDS = new Set([
  "line",
  "1",
  "one",
  "primary",
  "home",
  "mailing",
  "residential",
  "current",
  "personal",
  "permanent",
  "physical",
  "present",
]);

/**
 * Whether every word of a label is the key word or a neutral qualifier, so
 * "Cell Number" names the applicant's phone while "Phone Type" or
 * "Employer Address" (a word outside the set) does not.
 */
function isOnlyWordsOf(normalized: string, keys: Set<string>, qualifiers: Set<string>): boolean {
  const words = normalized.split(" ");
  return (
    words.some((word) => keys.has(word)) && words.every((w) => keys.has(w) || qualifiers.has(w))
  );
}

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
  const listed = NORMALIZED_LOOKUP.get(normalized);
  if (listed !== undefined) return listed;
  if (isOnlyWordsOf(normalized, PHONE_KEY_WORDS, PHONE_QUALIFIER_WORDS)) return "Phone";
  if (isOnlyWordsOf(normalized, ADDRESS_KEY_WORDS, ADDRESS_QUALIFIER_WORDS)) return "AddressLine";
  return null;
}
