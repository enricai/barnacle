// The expression constants are module-private; read them from source text.
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { widgetLabelMatches } from "@/scraper/flow-runner";

const src = readFileSync("src/scraper/flow-runner.ts", "utf8");
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
  const exprSrc = /const PROMPT_CURRENT_TEXT_EXPR = `([\s\S]*?)`;\n/.exec(src)?.[1] ?? "";
  const run = (html: string): string => {
    const win = new Window();
    win.document.body.innerHTML = html;
    const expr = exprSrc
      .replace(
        "${BUTTON_VALUE_EXPR}",
        (/const BUTTON_VALUE_EXPR =\s*\n?\s*"([\s\S]*?)";\n/.exec(src)?.[1] ?? "").replace(
          /\\"/g,
          '"'
        )
      )
      .replace("${OPTION_ACCESSIBLE_LABEL_EXPR}", "(() => '')")
      .replace(/\\\\/g, "\\");
    const fn = new win.Function(`return ${expr}`)();
    const w = win.document.querySelector("[role=combobox],button,input") as unknown;
    return fn(w, "[data-x]", emptyRx) as string;
  };
  it("a role=combobox <a> placeholder reads empty", () => {
    expect(run(`<a role="combobox"><span>— Make a Selection —</span></a>`)).toBe("");
  });
  it("a committed role=combobox <a> reads its text", () => {
    expect(run(`<a role="combobox"><span>+57 Colombia</span></a>`)).toBe("+57 colombia");
  });
  it("button behaviour unchanged", () => {
    expect(run(`<button>Mobile</button>`)).toBe("mobile");
  });
});

describe("widgetLabelMatches", () => {
  it("token overlap", () => {
    expect(widgetLabelMatches("Country Code", "Phone Country Code")).toBe(true);
    expect(widgetLabelMatches("Country Code", "Preferred Locations")).toBe(false);
  });
});
