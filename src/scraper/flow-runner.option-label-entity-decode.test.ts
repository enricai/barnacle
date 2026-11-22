// The expression constant is module-private; read it from source text.
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

const src = readFileSync("src/scraper/flow-runner.ts", "utf8");
const exprSrc =
  /const OPTION_ACCESSIBLE_LABEL_EXPR = `([\s\S]*?)`;\n/.exec(src)?.[1].replace(/\\\\/g, "\\") ?? "";

const run = (html: string) => {
  const win = new Window();
  win.document.body.innerHTML = html;
  const fn = new win.Function("document", `return ${exprSrc}`)(win.document);
  const el = win.document.querySelector("[role=option]") as unknown;
  return { label: fn(el) as string, imgs: win.document.querySelectorAll("img").length };
};

describe("option accessible label decodes character references", () => {
  it("decodes &#039; in aria-label", () => {
    const r = run(
      `<ul><li role="option" aria-label="Associate&#039;s Degree"><b>Associate's Degree</b></li></ul>`
    );
    expect(r.label).toBe("Associate's Degree");
  });
  it("double-escaped markup stays text and creates no element", () => {
    const r = run(`<ul><li role="option" aria-label="&lt;img src=x onerror=alert(1)&gt;"></li></ul>`);
    expect(r.label).toBe("<img src=x onerror=alert(1)>");
    expect(r.imgs).toBe(0);
  });
});
