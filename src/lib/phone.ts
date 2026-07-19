/**
 * Parses a US phone string into area code and subscriber number.
 * Some ATS backends require the phone split into `areaCode` (first 3 digits) and
 * `number` (remaining digits). Inputs shorter than 10 digits get an empty
 * `areaCode` so the partial number is still submitted as-is.
 */
export function parsePhone(raw: string): { areaCode: string; number: string } {
  const digits = raw.replace(/\D/g, "");
  if (digits.length >= 10) {
    return { areaCode: digits.slice(0, 3), number: digits.slice(3) };
  }
  return { areaCode: "", number: digits };
}
