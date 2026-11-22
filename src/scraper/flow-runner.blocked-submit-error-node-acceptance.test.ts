import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * End-to-end: a blocked submit whose ONLY invalid signal is a non-class
 * error-message node (`data-automation-id="errorMessage"`) must not be
 * credited via view-swap. The invalid-marker count is computed by the REAL
 * production expression evaluated against a happy-dom document.
 */
const SILENT = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;
const SUBMIT = "Click the 'Create Account' button";
const NEXT = "Click the 'Next Step' button";

describe("blocked submit revealing only a non-class error node", () => {
  it("is not credited and never reaches the next step", async () => {
    const win = new Window();
    win.document.body.innerHTML = `<form><input data-automation-id="email"></form>`;
    let bodyLen = 1000;
    let nextReached = false;
    const session = { on: () => {}, off: () => {} };
    const page = {
      evaluate: async (expr: unknown) => {
        const src = String(expr);
        if (src.includes("outerHTML") && src.includes("innerText")) {
          return { html: bodyLen, text: `${bodyLen}:${win.document.body.textContent}` };
        }
        if (src.includes("isInvalid(el)")) {
          return new win.Function("document", `return ${src};`)(win.document);
        }
        return null;
      },
      url: () => "https://example.example.com/apply",
      title: async () => "Create Account",
      locator: () => ({ first: () => ({ isChecked: async () => false, inputValue: async () => "" }) }),
      waitForTimeout: async () => {},
      getSessionForFrame: () => session,
      mainFrameId: () => "main",
      sendCDP: async () => ({ body: "{}", base64Encoded: false }),
    } as unknown as Page;
    const stagehand = {
      act: vi.fn().mockImplementation(async (input: unknown) => {
        const d = typeof input === "string" ? input : JSON.stringify(input);
        if (d.includes("Create Account")) {
          if (!win.document.querySelector("[data-automation-id=errorMessage]")) {
            const e = win.document.createElement("div");
            e.setAttribute("data-automation-id", "errorMessage");
            e.textContent = "Please enter a value in this field. ".repeat(40);
            win.document.body.appendChild(e);
            bodyLen += 1800;
          }
          return {
            success: true,
            message: "clicked",
            actionDescription: SUBMIT,
            actions: [
              { selector: "css=[data-automation-id=submit]", description: "Create Account", method: "click" },
            ],
          };
        }
        if (d.includes("Next Step")) nextReached = true;
        return { success: false, message: "none", actionDescription: d, actions: [] };
      }),
      observe: vi
        .fn()
        .mockImplementation(async (i?: unknown) =>
          typeof i === "string" ? [] : [{ selector: "xpath=//probe", description: "probe" }]
        ),
    } as unknown as Stagehand;
    const steps: HealingFlowStep[] = [SUBMIT, NEXT].map((instruction) => ({
      instruction,
      optional: false,
      upload: false,
      submitStep: false,
    }));
    await expect(
      runHealingFlow({
        stagehand,
        page,
        steps,
        logger: SILENT,
        anthropic: null,
        rephraseModel: null,
        uploadFixture: null,
      })
    ).rejects.toMatchObject({ name: "StepVerificationError" });
    expect(nextReached).toBe(false);
  });
});
