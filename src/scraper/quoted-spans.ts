const APOSTROPHE_PLACEHOLDER = "\u0000";
const ALPHANUMERIC = /[A-Za-z0-9]/;
const SINGLE_QUOTED_SPAN = /'([^']+)'/g;

export interface QuotedSpan {
  text: string;
  start: number;
  end: number;
}

function isAlphanumeric(char: string | undefined): boolean {
  return char !== undefined && ALPHANUMERIC.test(char);
}

/**
 * Hides apostrophes that belong to a quoted value rather than delimiting it, so
 * a runtime value spliced between quotes is read back in full: contractions and
 * possessives (alphanumeric on both sides) plus a leading or trailing
 * apostrophe of the value itself (`''Smith'`, `'Smith''`). Open/closed state is
 * tracked across the text; the output has the same length as the input.
 */
export function maskApostrophes(text: string): string {
  const chars = [...text];
  let inSpan = false;
  let index = 0;
  while (index < chars.length) {
    if (chars[index] !== "'") {
      index++;
      continue;
    }
    let end = index;
    while (chars[end] === "'") end++;
    const run = end - index;
    const nextIsValue = isAlphanumeric(chars[end]);
    const interior = run === 1 && isAlphanumeric(chars[index - 1]) && nextIsValue;
    const opens = !inSpan && !interior;
    const closes = !interior && (inSpan ? !(run > 1 && nextIsValue) : run > 1 && !nextIsValue);
    // The opening delimiter is the first quote of the run and the closing one
    // the last; every other quote in the run is value content.
    for (let at = index; at < end; at++) {
      const isDelimiter = (opens && at === index) || (closes && at === end - 1);
      if (!isDelimiter) chars[at] = APOSTROPHE_PLACEHOLDER;
    }
    if (opens !== closes) inSpan = !inSpan;
    index = end;
  }
  return chars.join("");
}

/**
 * Reverses `maskApostrophes` on text captured from a masked string.
 */
export function restoreApostrophes(text: string): string {
  return text.replaceAll(APOSTROPHE_PLACEHOLDER, "'");
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
