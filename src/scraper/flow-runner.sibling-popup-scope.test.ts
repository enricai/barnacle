import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import { PROMPT_SCOPE_ROOT_EXPR } from "@/scraper/flow-runner";

function scope(html: string, id: string) {
  const window = new Window();
  window.document.body.innerHTML = html;
  const g = globalThis as unknown as Record<string, unknown>;
  const prev = g.document;
  g.document = window.document;
  try {
    const fn = new Function(`return ${PROMPT_SCOPE_ROOT_EXPR}`)();
    const el = window.document.getElementById(id);
    const r = fn(el);
    return { r, doc: window.document };
  } finally {
    g.document = prev;
  }
}

describe("PROMPT_SCOPE_ROOT_EXPR sibling popup", () => {
  it("scopes to a following sibling[aria-owns] holding input + listbox", () => {
    const { r } = scope(
      `<div id="t" role="combobox" aria-expanded="true"></div>
       <div id="p" aria-owns="lb" aria-expanded="true"><input/><div id="lb" role="listbox"><div role="option">A</div></div></div>`,
      "t"
    );
    expect(r.id).toBe("p");
  });
  it("prefers the sibling whose aria-expanded tracks the trigger", () => {
    const { r } = scope(
      `<div id="t" role="combobox" aria-expanded="true"></div>
       <div id="x" aria-expanded="false"><div role="listbox"></div></div>
       <div id="y" aria-expanded="true"><div role="listbox"></div></div>`,
      "t"
    );
    expect(r.id).toBe("y");
  });
  it("keeps aria-controls ref and inline listbox behaviour", () => {
    const a = scope(
      `<div id="t" aria-controls="lb"></div><div id="s"><div role="listbox"></div></div><div id="lb" role="listbox"></div>`,
      "t"
    );
    expect(a.r.id).toBe("lb");
    const b = scope(`<div id="t"><div role="listbox"></div></div>`, "t");
    expect(b.r.id).toBe("t");
  });
  it("falls back to document with no popup", () => {
    const { r, doc } = scope(`<div id="t" role="combobox"></div><div id="n"></div>`, "t");
    expect(r).toBe(doc);
  });
});
