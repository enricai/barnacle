import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { DROP_ZONE_SELECTORS, FIND_DROP_ZONE_EXPR } from "@/scraper/upload-affordance-expr";

describe("DROP_ZONE_SELECTORS", () => {
  it("keeps class and tag selectors", () => {
    expect(DROP_ZONE_SELECTORS).toContain("[class*='dropzone']");
    expect(DROP_ZONE_SELECTORS).toContain("uapp-upload");
  });

  it("includes attribute-identified drop areas", () => {
    expect(DROP_ZONE_SELECTORS).toContain("[data-testid*='drop' i][data-testid*='file' i]");
  });
});

describe("DROP_ZONE_SELECTORS against a DOM", () => {
  const query = (html: string): unknown => {
    const window = new Window();
    window.document.body.innerHTML = html;
    return window.document.querySelector(DROP_ZONE_SELECTORS.join(","));
  };

  it("matches an attribute-only drop area case-insensitively", () => {
    expect(query(`<div data-testid="File-Drop-Area"></div>`)).not.toBeNull();
  });

  it("does not match an unrelated drop attribute", () => {
    expect(query(`<div data-testid="drop-down-menu"></div>`)).toBeNull();
  });
});

describe("FIND_DROP_ZONE_EXPR against a DOM", () => {
  const find = (html: string): unknown => {
    const window = new Window();
    window.document.body.innerHTML = html;
    return new Function("document", `return ${FIND_DROP_ZONE_EXPR}(document);`)(window.document);
  };

  it.each([
    `<div data-area="file-drop"></div>`,
    `<div id="dropzone"></div>`,
    `<section data-widget="upload-drop-region"></section>`,
  ])("finds a drop area identified by a non-class attribute: %s", (html) => {
    expect(find(html)).not.toBeNull();
  });

  it("ignores dropdown menus", () => {
    expect(find(`<div id="menu" data-x="drop-down"></div>`)).toBeNull();
  });
});
