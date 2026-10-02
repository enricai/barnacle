import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Pins recon-view-swap-click-credited-on-bare-url-reload-without-
 * destination-check.md's second site: the n+16 retry/escalation fallback
 * independently recomputes `retryUrlChanged` from the raw pre/post URL
 * strings at flow-runner.ts (the `retryUrlChanged` const inside the n+16
 * fallback block), feeding `record.verifiedBy` and several downstream retry
 * gates. A trusted click throws, the synthetic `el.click()` fallback fires,
 * and the clicked element's own handler only mutates the query string on
 * the SAME origin+path (a client-side reload/step counter, not a real
 * navigation) — that must not be credited as a verified advance. Site-
 * agnostic fixture (generic "apply.example.com" careers-application flow),
 * not any real site or plugin.
 */

const BASE_URL = "https://apply.example.com/account/create";
const CREATE_ACCOUNT_STEP = "Click the 'Create account' button to submit the signup form";

const SILENT_LOGGER_CALLS = { info: [] as string[], warn: [] as string[] };
const testLogger = {
  info: vi.fn((msg: string) => SILENT_LOGGER_CALLS.info.push(msg)),
  warn: vi.fn((msg: string) => SILENT_LOGGER_CALLS.warn.push(msg)),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

describe("flow-runner n+16 fallback — fallback-clicked element only reloads the same origin+path with a new query string (offline fixture, live happy-dom, no network)", () => {
  it("does not credit the step as verified via retryUrlChanged on a same-path query-only reload", async () => {
    const window = new Window({ url: BASE_URL });
    const document = window.document;
    document.body.innerHTML = `
      <button id="createAccountBtn" type="button">Create account</button>
    `;

    const targetEl = document.getElementById("createAccountBtn") as unknown as HappyDomElement;
    expect(targetEl).not.toBeNull();

    let clickActivations = 0;
    let currentUrl = BASE_URL;
    const currentTitle = "Create Account";
    (
      targetEl as unknown as {
        addEventListener: (type: string, cb: (ev: unknown) => void) => void;
      }
    ).addEventListener("click", () => {
      clickActivations += 1;
      // Same origin AND same pathname — only the query string changes, the
      // shape of a client-side step-counter reload, not a real navigation.
      currentUrl = `${BASE_URL}?step=2`;
    });

    const documentElement = document.documentElement as unknown as HappyDomElement;
    const win = window as unknown as { XPathResult?: unknown };
    win.XPathResult = { FIRST_ORDERED_NODE_TYPE: 9 };
    (document as unknown as { evaluate: (expr: string) => { singleNodeValue: unknown } }).evaluate =
      (expr: string) => {
        const node = expr === "/HTML[1]/BODY[1]/BUTTON[1]" ? targetEl : null;
        return { singleNodeValue: node };
      };
    void documentElement;

    const session = { on: () => {}, off: () => {} };
    const page: Page = {
      evaluate: async (expr: unknown): Promise<unknown> => {
        const src = String(expr);
        const fn = new window.Function("document", "XPathResult", `return (${src});`) as (
          d: unknown,
          x: unknown
        ) => unknown;
        return fn(document, win.XPathResult);
      },
      url: () => currentUrl,
      title: async () => currentTitle,
      // The top-window trusted-click delivery primitive: rejects, forcing
      // attemptN16TrustedClick down its outer catch and into the synthetic
      // el.click() fallback — same shape as the reported "trusted click
      // throws" precondition.
      locator: () => ({
        first: () => ({
          click: async () => {
            throw new Error("not actionable");
          },
          isChecked: async () => false,
          inputValue: async () => "",
        }),
      }),
      waitForTimeout: async () => {},
      getSessionForFrame: () => session,
      mainFrameId: () => "main",
      sendCDP: async () => ({ body: "{}", base64Encoded: false }),
    } as unknown as Page;

    const stagehand: Stagehand = {
      act: vi.fn().mockResolvedValue({
        success: true,
        message: "clicked",
        actionDescription: CREATE_ACCOUNT_STEP,
        actions: [
          {
            selector: "xpath=/HTML[1]/BODY[1]/BUTTON[1]",
            description: "Create account",
            method: "click",
          },
        ],
      }),
      observe: vi
        .fn()
        .mockImplementation(async (instruction?: unknown) =>
          typeof instruction === "string"
            ? []
            : [{ selector: "xpath=//probe-presence", description: "probe-presence" }]
        ),
    } as unknown as Stagehand;

    // Unflagged bridge step — mirrors the report's replan-generated step
    // that never carries submitStep:true. A single-step flow keeps this
    // step non-final too (no isFinalStep-only escape hatch available).
    const STEPS: HealingFlowStep[] = [
      { instruction: CREATE_ACCOUNT_STEP, optional: false, upload: false, submitStep: false },
    ];

    await expect(
      runHealingFlow({
        stagehand,
        page,
        steps: STEPS,
        logger: testLogger,
        anthropic: null,
        rephraseModel: null,
        uploadFixture: null,
      })
    ).rejects.toThrow(/failed verification/);

    expect(clickActivations).toBeGreaterThan(0);

    const n16ProbeLines = SILENT_LOGGER_CALLS.info.filter((line) => line.includes("n+16 probe"));
    const deliveredViaFallback = n16ProbeLines.filter((line) =>
      line.includes("delivery=synthetic-fallback")
    );
    expect(deliveredViaFallback.length).toBeGreaterThan(0);

    // A same-path query-only reload must not be credited as a URL change —
    // the step must not be verified on any n+16 fallback attempt.
    expect(deliveredViaFallback.every((line) => /\burl=false\b/.test(line))).toBe(true);
    expect(deliveredViaFallback.every((line) => /verified=false/.test(line))).toBe(true);
  });
});
