import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { DROP_ZONE_SELECTORS } from "@/scraper/upload-affordance-expr";

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
  const query = (html: string): Element | null => {
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
