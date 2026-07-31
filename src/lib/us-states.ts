/**
 * Shared US state and territory name→abbreviation map. Extracted from
 * site-specific copies in appcast and encompasshealth so any plugin can
 * resolve a full state name (or a 2-letter code) to an uppercase abbreviation
 * without duplicating this data.
 *
 * Covers all 50 states, the District of Columbia, and the 5 US territories:
 * American Samoa (AS), Guam (GU), Northern Mariana Islands (MP),
 * Puerto Rico (PR), and U.S. Virgin Islands (VI).
 */

export const US_STATE_NAMES: Record<string, string> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
  "district of columbia": "DC",
  "american samoa": "AS",
  guam: "GU",
  "northern mariana islands": "MP",
  "puerto rico": "PR",
  "u.s. virgin islands": "VI",
};

/**
 * Converts a US state/territory name or existing 2-letter code to its
 * uppercase abbreviation. Input is trimmed before matching so surrounding
 * whitespace never causes a spurious identity fallback. Already-abbreviated
 * 2-letter inputs pass through uppercased; unrecognised inputs are returned
 * trimmed but otherwise unchanged (identity fallback).
 */
export function stateToCode(state: string): string {
  const trimmed = state.trim();
  if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase();
  return US_STATE_NAMES[trimmed.toLowerCase()] ?? trimmed;
}
