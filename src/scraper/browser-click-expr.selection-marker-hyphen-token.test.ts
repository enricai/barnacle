import { describe, expect, it } from "vitest";

import {
  SELECTION_MARKER_CLASS_SELECTOR_SRC,
  SELECTION_MARKER_CLASS_TOKEN_REGEX_SRC,
} from "@/scraper/browser-click-expr";

/**
 * Regression for bugfix-001: a custom option list authored with a
 * hyphen-compound state token (e.g. `result-selectable` flipping to
 * `result-selected` on commit) never matched the old whole-token-only
 * enumeration, so every predicate sharing this vocabulary was blind to it.
 */
function parseRegexSrc(src: string): RegExp {
  const match = /^\/(.*)\/$/.exec(src);
  if (!match?.[1]) throw new Error(`unparseable regex source: ${src}`);
  return new RegExp(match[1]);
}

describe("SELECTION_MARKER_CLASS_TOKEN_REGEX_SRC", () => {
  const rx = parseRegexSrc(SELECTION_MARKER_CLASS_TOKEN_REGEX_SRC);

  it.each([
    ["selected", true],
    ["is-selected", true],
    ["Mui-selected", true],
    ["result-selected", true],
    ["result-selectable", true],
    ["active", true],
    ["checked", true],
    ["selectable", true],
    ["option result-selected small", true],
    ["dropdown-option selected", true],
  ])("matches %s -> %s", (className, expected) => {
    expect(rx.test(className)).toBe(expected);
  });

  it.each([
    ["unselected", false],
    ["option", false],
    ["disabled", false],
  ])("does not match %s -> %s", (className, expected) => {
    expect(rx.test(className)).toBe(expected);
  });
});

describe("SELECTION_MARKER_CLASS_SELECTOR_SRC", () => {
  it("includes a substring clause for every hyphen-compound state word the regex recognizes", () => {
    for (const word of ["selected", "selectable", "active", "checked"]) {
      expect(SELECTION_MARKER_CLASS_SELECTOR_SRC).toContain(`[class*="-${word}"]`);
    }
  });

  it("still includes the bare state-word class selectors", () => {
    for (const word of ["selected", "selectable", "active", "checked"]) {
      expect(SELECTION_MARKER_CLASS_SELECTOR_SRC.split(",")).toContain(`.${word}`);
    }
  });
});
