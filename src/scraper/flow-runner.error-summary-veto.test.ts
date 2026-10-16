// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { ADVANCE_CLICK_RX, ERROR_SUMMARY_EXPR } from "@/scraper/flow-runner";

function shows(html: string): boolean {
  const doc = (globalThis as unknown as { document: { body: { innerHTML: string } } }).document;
  doc.body.innerHTML = html;
  return new Function(`return ${ERROR_SUMMARY_EXPR}`)() as boolean;
}

describe("n+16 error-summary veto expression", () => {
  it("flags a heading whose whole text is 'Errors Found'", () => {
    expect(shows(`<h2>Errors Found</h2><ul><li>Phone Number format</li></ul>`)).toBe(true);
  });

  it("flags a counted 'N errors found' button", () => {
    expect(shows(`<button>3 errors found</button>`)).toBe(true);
  });

  it("flags a visible role=alert that mentions an error", () => {
    expect(shows(`<div role="alert">There was an error with your entry</div>`)).toBe(true);
  });

  it("ignores a role=alert toast that mentions no error", () => {
    expect(shows(`<div role="alert">Progress saved</div>`)).toBe(false);
  });

  it("ignores prose that merely contains the words", () => {
    expect(shows(`<p>Review complete: no errors found in your résumé.</p>`)).toBe(false);
  });

  it("is quiet on a clean page", () => {
    expect(shows(`<h1>My Information</h1>`)).toBe(false);
  });
});

describe("ADVANCE_CLICK_RX", () => {
  it("names advance controls only", () => {
    expect(ADVANCE_CLICK_RX.test("Click 'Save and Continue'")).toBe(true);
    expect(ADVANCE_CLICK_RX.test("Check the 'I agree' checkbox")).toBe(false);
  });
});
