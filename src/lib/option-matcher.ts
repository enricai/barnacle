import { getLogger } from "@/lib/logging";
import { US_STATE_NAMES } from "@/lib/us-states";

const logger = getLogger({ name: "lib/option-matcher" });

/**
 * Known synonyms keyed by their canonical option value (lowercased).
 * When a payload sends a synonym, we return the canonical option.
 */
export const SEMANTIC_EQUIVALENCES: Record<string, string[]> = {
  "i do not wish to disclose": [
    "prefer not to say",
    "prefer not to disclose",
    "decline to answer",
    "decline",
  ],
  no: ["na", "n/a", "not applicable"],
  "not a veteran": ["not applicable"],
  "master's degree": ["ms", "m.s.", "masters", "master"],
  "bachelor's degree": ["bs", "b.s.", "ba", "b.a.", "bachelors", "bachelor"],
  "doctorate degree": ["phd", "ph.d.", "doctorate", "doctoral"],
  "higher degree (phd/jd/md/do)": ["jd", "j.d.", "md", "m.d.", "do", "d.o."],
  "associate's degree/college diploma": ["as", "a.s.", "aa", "a.a.", "associates", "associate"],
  "high school diploma/ged": ["ged", "high school", "hs"],
};

/**
 * Match a raw value against a question's allowed options. Dropdown questions
 * on ATS forms require the submitted value to be one of the declared options —
 * sending an out-of-list value typically causes a server error.
 *
 * Matching cascade: exact → case-insensitive → US state name→abbrev →
 * semantic equivalence → substring containment → fallback to first option.
 */
export function matchToOptions(rawValue: string, options: unknown[]): string {
  const stringOpts = options.filter((o): o is string => typeof o === "string");
  if (stringOpts.length === 0) return rawValue;

  const raw = rawValue.trim();

  for (const opt of stringOpts) {
    if (opt === raw) return opt;
  }

  const rawLower = raw.toLowerCase();
  for (const opt of stringOpts) {
    if (opt.toLowerCase() === rawLower) return opt;
  }

  const stateAbbrev = US_STATE_NAMES[rawLower];
  if (stateAbbrev) {
    for (const opt of stringOpts) {
      if (opt.toUpperCase() === stateAbbrev) return opt;
    }
  }

  for (const opt of stringOpts) {
    const synonyms = SEMANTIC_EQUIVALENCES[opt.toLowerCase()];
    if (synonyms?.some((s) => s === rawLower)) return opt;
  }

  for (const opt of stringOpts) {
    if (opt.toLowerCase().includes(rawLower) || rawLower.includes(opt.toLowerCase())) return opt;
  }

  logger.warn(
    `option mismatch: raw="${raw}" not in [${stringOpts.slice(0, 5).join(", ")}${stringOpts.length > 5 ? ", ..." : ""}] — using fallback "${stringOpts[0]}"`
  );
  return stringOpts[0] as string;
}
