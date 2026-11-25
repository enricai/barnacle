import type { Page } from "@browserbasehq/stagehand";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import {
  countNgInvalidContainers,
  isSelectionIntentStep,
  verifyPromptSelectorCommitted,
} from "@/scraper/flow-runner";

/** A frame target that evaluates the production expression against a happy-dom document. */
function targetFor(html: string) {
  const win = new Window();
  win.document.body.innerHTML = html;
  const target = {
    evaluate: async (expr: string) => new win.Function("document", `return ${expr};`)(win.document),
  };
  return target as unknown as Parameters<typeof countNgInvalidContainers>[0] & {
    page?: Page;
  };
}

describe("countNgInvalidContainers — non-Angular validation markers", () => {
  const shapes: Record<string, string> = {
    "aria-invalid field": `<input aria-invalid="true">`,
    "field-level inputError node": `<div data-automation-id="inputError">Enter a value</div>`,
    "errorHeading of an error summary": `<h2 data-testid="errorHeading">2 errors found</h2>`,
    "aria-errormessage target": `<input aria-errormessage="e1"><span id="e1">Required</span>`,
    "has-error container": `<div class="form-group has-error"><input></div>`,
    "kebab error-message class": `<p class="error-message">Required</p>`,
  };
  for (const [name, html] of Object.entries(shapes)) {
    it(`counts a visible ${name}`, async () => {
      expect(await countNgInvalidContainers(targetFor(html))).toBeGreaterThan(0);
    });
  }

  it("does not count an empty or hidden error node, or a clean form", async () => {
    const html = `<form><input></form>
      <div data-automation-id="inputError"></div>
      <div class="error-message" hidden>Required</div>
      <input aria-errormessage="e2"><span id="e2" aria-hidden="true">Required</span>
      <span class="terror-free">fine</span>`;
    expect(await countNgInvalidContainers(targetFor(html))).toBe(0);
  });
});

describe("select-step commit guard", () => {
  it("recognises select, choose and pick wording, not catch-alls or plain clicks", () => {
    expect(isSelectionIntentStep("In the 'Source' dropdown, select 'Web'")).toBe(true);
    expect(isSelectionIntentStep("Choose 'Web' from the 'Source' dropdown")).toBe(true);
    expect(isSelectionIntentStep("Pick the 'Web' option for 'Source'")).toBe(true);
    expect(isSelectionIntentStep("Select any remaining 'Source' options")).toBe(false);
    expect(isSelectionIntentStep("Click the 'Continue' button")).toBe(false);
  });

  const opener = `<div class="field"><label for="w">Source</label><button id="w" type="button">0 items selected</button></div>`;
  for (const selector of ["xpath=//*[@id='w']", "css=#w"]) {
    it(`reads an opener button stating zero selected as uncommitted (${selector})`, async () => {
      const r = await verifyPromptSelectorCommitted(targetFor(opener), selector, "Web", true);
      expect(r).toEqual({ isPromptWidget: true, committed: false });
    });
  }

  it("reads an opener stating a positive count as committed", async () => {
    const html = opener.replace("0 items", "1 items");
    const r = await verifyPromptSelectorCommitted(targetFor(html), "css=#w", "Web", true);
    expect(r).toEqual({ isPromptWidget: true, committed: true });
  });
});
