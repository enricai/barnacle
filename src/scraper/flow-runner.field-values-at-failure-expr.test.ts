import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { type FieldValueAtFailure, fieldValuesAtFailureExpr } from "@/scraper/flow-runner";

/**
 * `fieldValuesAtFailureExpr`'s source runs the SAME label-matching/live-value
 * logic the production failure-dump capture sites evaluate in the browser —
 * executed here via `new Function` against a genuine happy-dom document,
 * mirroring `flow-runner.frame-primitives.test.ts`'s real-`evaluate` pattern,
 * so a break in either the accessible-name resolution or the live-property
 * read would fail this test even though a mocked `evaluate` never could.
 */
describe("flow-runner/fieldValuesAtFailureExpr", () => {
  function runExpr(window: Window): FieldValueAtFailure[] {
    const fn = new Function("document", "CSS", `return (${fieldValuesAtFailureExpr()});`) as (
      document: unknown,
      css: unknown
    ) => FieldValueAtFailure[];
    return fn(window.document, window.CSS);
  }

  it("returns the live `.value`-property value keyed by label, which a reparsed outerHTML snapshot of the same control would show as empty", () => {
    const window = new Window();
    const document = window.document;
    document.body.innerHTML = `
      <form>
        <label for="full_name">Full name</label>
        <input id="full_name" name="full_name" />
      </form>
    `;
    const input = document.getElementById("full_name") as unknown as {
      value: string;
    };
    // The DOM-direct fill path: `el.value = value` sets the JS property only
    // — it never reaches the serialized `value=` content attribute.
    input.value = "Jordan Rivera";
    expect(document.body.innerHTML).not.toContain("Jordan Rivera");

    const result = runExpr(window);

    expect(result).toContainEqual({ label: "Full name", value: "Jordan Rivera" });
  });

  it("falls back through aria-label, then name/id/placeholder, mirroring recon-browser.ts's accessibleNameForControl order", () => {
    const window = new Window();
    const document = window.document;
    document.body.innerHTML = `
      <input aria-label="Email address" name="email" />
      <input name="phone" placeholder="Phone number" />
    `;
    const [emailEl, phoneEl] = Array.from(document.querySelectorAll("input")) as unknown as {
      value: string;
    }[];
    (emailEl as { value: string }).value = "jordan@example.com";
    (phoneEl as { value: string }).value = "555-0100";

    const result = runExpr(window);

    expect(result).toContainEqual({ label: "Email address", value: "jordan@example.com" });
    // `name` outranks `placeholder` in the fallback order, mirroring
    // `accessibleNameForControl`'s `name || id || placeholder`.
    expect(result).toContainEqual({ label: "phone", value: "555-0100" });
  });

  it("reports a checkbox's live checked state, not an empty value", () => {
    const window = new Window();
    const document = window.document;
    document.body.innerHTML = `
      <label for="accept">I agree</label>
      <input type="checkbox" id="accept" />
    `;
    const checkbox = document.getElementById("accept") as unknown as { checked: boolean };
    checkbox.checked = true;

    const result = runExpr(window);

    expect(result).toContainEqual({ label: "I agree", value: "1" });
  });

  it("omits a control with no resolvable accessible name at all", () => {
    const window = new Window();
    const document = window.document;
    document.body.innerHTML = `<input />`;
    const input = document.querySelector("input") as unknown as { value: string };
    input.value = "untethered";

    const result = runExpr(window);

    expect(result).toEqual([]);
  });
});
