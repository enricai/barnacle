// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { IS_DATE_SEGMENT_EXPR } from "@/scraper/segmented-date-spinbutton";

const check = (html: string, id: string): boolean => {
  const g = globalThis as unknown as {
    document: { body: { innerHTML: string }; getElementById(id: string): unknown };
  };
  g.document.body.innerHTML = html;
  const el = g.document.getElementById(id);
  return (new Function(`return ${IS_DATE_SEGMENT_EXPR}`)() as () => boolean).call(el);
};
const spin = (id: string, extra = ""): string => `<input id="${id}" role="spinbutton" ${extra}/>`;

describe("IS_DATE_SEGMENT_EXPR", () => {
  it("treats sibling segments in a group as date segments", () => {
    expect(check(`<div role="group" aria-label="Date">${spin("a")}${spin("b")}</div>`, "a")).toBe(
      true
    );
  });
  it("treats a lone spinbutton as not a segment", () => {
    expect(check(`<div>${spin("a")}</div>`, "a")).toBe(false);
  });
  it("ignores unresolved aria-labelledby ids so the wrapper gives no caption", () => {
    const html = `<div aria-labelledby="missing  nope"><div>${spin("a")}</div></div><div>${spin("b")}</div>`;
    expect(check(html, "a")).toBe(false);
  });
  it("resolves aria-labelledby ids as a caption owner", () => {
    const html = `<span id="t">When</span><div aria-labelledby="t"><div>${spin("a")}</div><div>${spin("b")}</div></div>`;
    expect(check(html, "a")).toBe(true);
  });
});
