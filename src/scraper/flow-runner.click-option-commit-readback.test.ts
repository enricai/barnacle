import { Window } from "happy-dom";
import { expect, it } from "vitest";
import { isSelectionIntentStep, verifyPromptSelectorCommitted } from "@/scraper/flow-runner";

const targetFor = (html: string): never => {
  const w = new Window();
  w.document.body.innerHTML = html;
  return {
    evaluate: async (e: string) => new w.Function("document", `return ${e};`)(w.document),
  } as never;
};
const PICK_STEP =
  "click the 'Week Select' dropdown (it currently shows '22 - 28 November') to open its list of weeks, then click the week option '13 - 19 December'";
it("reads a click-the-option step as a selection only when it names its dropdown", () => {
  expect(isSelectionIntentStep(PICK_STEP)).toBe(true);
  expect(isSelectionIntentStep("Click the option 'Yes'")).toBe(false);
  expect(isSelectionIntentStep("Click the 'Week' dropdown to open it")).toBe(false);
});
it("rejects an unchanged pick, not a committed or re-rendered one", async () => {
  const f = (txt: string) =>
    `<div class="Select"><div id="v" class="Select-placeholder">${txt}</div><div class="Select-input"><input></div></div>`;
  const r = async (h: string, s = "css=#v") =>
    verifyPromptSelectorCommitted(targetFor(h), s, "13 - 19 December", true);
  expect(await r(f("22 - 28 November"))).toEqual({ isPromptWidget: true, committed: false });
  expect(await r(f("13 - 19 December"))).toEqual({ isPromptWidget: true, committed: true });
  expect((await r(f("x"), "css=#gone"))?.isPromptWidget).toBe(false);
  const ctrl = (t: string) =>
    `<div class="Select"><div id="c" class="Select-control"><span>${t}</span><div><input></div></div></div>`;
  expect(await r(ctrl("13 - 19 December"), "css=#c")).toEqual({
    isPromptWidget: true,
    committed: true,
  });
});
