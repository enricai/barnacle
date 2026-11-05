import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import { widgetLabelMatches } from "@/scraper/flow-runner";

// The expression constants are module-private; read them from source text.
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./flow-runner.ts", import.meta.url), "utf8");
const rxMatch = /const PROMPT_EMPTY_VALUE_RX =\s*(\/.*\/i);/.exec(src);
const emptyRx = new Function(`return ${rxMatch?.[1]}`)() as RegExp;

describe("empty placeholder regex", () => {
  it.each(["— Make a Selection —", "Make a Selection", "Select One", "0 items selected"])(
    "%s is empty",
    (t) => expect(emptyRx.test(t.trim())).toBe(true)
  );
  it("a chosen label is not empty", () => {
    expect(emptyRx.test("+1 United States")).toBe(false);
  });
});

describe("combobox read-back", () => {
  it("source reads non-input role=combobox like a button", () => {
    expect(src).toContain('getAttribute("role") === "combobox" && w.tagName !== "INPUT"');
    const w = new Window().document;
    w.body.innerHTML = `<a role="combobox"><span>— Make a Selection —</span></a>`;
    expect(w.querySelector("a")?.textContent).toContain("Make a Selection");
  });
});

describe("widgetLabelMatches", () => {
  it("token overlap", () => {
    expect(widgetLabelMatches("Country Code", "Phone Country Code")).toBe(true);
    expect(widgetLabelMatches("Country Code", "Preferred Locations")).toBe(false);
  });
});
