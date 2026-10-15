const APOSTROPHE_PLACEHOLDER = "\u0000";
const APOSTROPHE_BETWEEN_LETTERS = /(?<=[A-Za-z])'(?=[A-Za-z])/g;
const ESCAPED_APOSTROPHE = /\\'/g;
const ESCAPE_PLACEHOLDER = "\u0001\u0001";
const SINGLE_QUOTED_SPAN = /'([^']+)'/g;

export interface QuotedSpan {
  text: string;
  start: number;
  end: number;
}

/**
 * Hides contraction/possessive apostrophes (letter on both sides) and
 * backslash-escaped apostrophes so they are not mistaken for quote delimiters;
 * the output has the same length as the input.
 */
export function maskApostrophes(text: string): string {
  return text
    .replace(ESCAPED_APOSTROPHE, ESCAPE_PLACEHOLDER)
    .replace(APOSTROPHE_BETWEEN_LETTERS, APOSTROPHE_PLACEHOLDER);
}

/**
 * Makes a runtime value safe to splice between single quotes: apostrophes that
 * masking would not hide get a backslash escape the parsers honour, so the
 * value cannot end the span early. Letter-flanked apostrophes stay untouched.
 */
export function escapeQuotedValue(value: string): string {
  return value.replace(/(?<![A-Za-z])'|'(?![A-Za-z])/g, "\\'");
}

/**
 * Reverses `maskApostrophes` on text captured from a masked string.
 */
export function restoreApostrophes(text: string): string {
  return text.replaceAll(ESCAPE_PLACEHOLDER, "'").replaceAll(APOSTROPHE_PLACEHOLDER, "'");
}

/**
 * Finds real single-quoted spans in instruction copy. `start`/`end` index the
 * ORIGINAL string (delimiters inclusive) and `text` has apostrophes restored.
 */
export function findQuotedSpans(text: string): QuotedSpan[] {
  return Array.from(maskApostrophes(text).matchAll(SINGLE_QUOTED_SPAN), (match) => ({
    text: restoreApostrophes(match[1] ?? ""),
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
}

export interface AnchoredMatch {
  /** Full match followed by capture groups, apostrophes restored; unmatched groups are `undefined`. */
  groups: (string | undefined)[];
  start: number;
  end: number;
}

/**
 * Runs an anchored-verb regex over the apostrophe-masked instruction so every
 * parser shares one tokenizer: a letter-flanked apostrophe never ends a quoted
 * span. `start`/`end` index the ORIGINAL string (masking preserves length).
 */
export function matchAnchored(text: string, pattern: RegExp): AnchoredMatch | null {
  const match = pattern.exec(maskApostrophes(text));
  if (!match) return null;
  const start = match.index;
  return {
    groups: Array.from(match, (group) =>
      group === undefined ? undefined : restoreApostrophes(group)
    ),
    start,
    end: start + match[0].length,
  };
}
