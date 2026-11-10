import { describe, expect, it } from "vitest";
import { withClearBeforeType } from "./flow-runner";

describe("withClearBeforeType", () => {
  it("adds select-all/replace to a click-then-type rephrase", () => {
    const out = withClearBeforeType("Click the email input, then type a@example.com");
    expect(out).toMatch(/selecting all existing text/);
    expect(out.startsWith("Click the email input, then type a@example.com")).toBe(true);
  });
  it("is idempotent", () => {
    const once = withClearBeforeType("Click the email input and type a@example.com");
    expect(withClearBeforeType(once)).toBe(once);
  });
  it("leaves non-typing instructions unchanged", () => {
    expect(withClearBeforeType("Click the Continue button")).toBe("Click the Continue button");
  });
});

describe("withClearBeforeType only clears before typing into a field", () => {
  it("leaves a key press unchanged", () => {
    expect(withClearBeforeType("Press Enter to submit the form")).toBe(
      "Press Enter to submit the form"
    );
  });
  it("leaves a click on a button whose label says Enter unchanged", () => {
    expect(withClearBeforeType("Click the 'Enter Your Information' button")).toBe(
      "Click the 'Enter Your Information' button"
    );
  });
  it("leaves a click on an input field unchanged", () => {
    expect(withClearBeforeType("Click the Email input field")).toBe("Click the Email input field");
  });
  it("leaves a click on an input inside a form unchanged", () => {
    expect(withClearBeforeType("Click the Email input in the form")).toBe(
      "Click the Email input in the form"
    );
  });
  it("clears when a click is followed by entering a value", () => {
    expect(withClearBeforeType("Click the Email field and enter user@example.com")).toMatch(
      /selecting all existing text/
    );
  });
  it("clears before typing into a field with no click", () => {
    expect(withClearBeforeType("Type 'user@example.com' into the Email input field")).toMatch(
      /selecting all existing text/
    );
  });
  it("clears before entering a value into a field", () => {
    expect(withClearBeforeType("Enter user@example.com in the Email field")).toMatch(
      /selecting all existing text/
    );
  });
  it("still clears when the typed value itself says clear", () => {
    expect(withClearBeforeType("Click the notes box and type 'Please clear the backlog'")).toMatch(
      /selecting all existing text/
    );
  });
});
