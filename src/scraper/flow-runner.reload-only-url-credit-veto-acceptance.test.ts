import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Pins the report's exact failure shape at the main attempt-loop credit
 * decision (flow-runner.ts's `urlChanged`/`verified`/`record.verifiedBy`
 * trio): a plain click step (no submitStep flag) whose post-click URL
 * differs from the pre-click URL only by a transient query param / redirect
 * round-trip on the identical origin+path (the report's clientRequestID
 * pattern) must not be credited verified via `verifiedBy=url`. No DOM
 * change, no network signal, and no view-swap accompanies the click — the
 * ONLY candidate signal is the raw URL-string inequality, which
 * `hasOriginOrPathChanged` must veto. The resolved action selector is a
 * plain CSS selector (not `xpath=`-prefixed) so this exercises ONLY the
 * 11828 producer and its direct consumers, not the separate n+16
 * fallback's own xpath-gated retry path. Site-agnostic apply.example.com-
 * style fixture, not any real site or plugin.
 */

const BASE_URL = "https://apply.example.com/profile?tab=basic";
const POST_CLICK_URL = "https://apply.example.com/profile?tab=basic&clientRequestID=9f1c2e";
const TOGGLE_STEP = "Click the 'View details' toggle";

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

describe("flow-runner attempt loop — a same-path cosmetic-query reload is not credited verifiedBy=url", () => {
  it("does not credit a non-submit click step as verified when the only post-click signal is a same-origin, same-path query-string change", async () => {
    const window = new Window({ url: BASE_URL });
    const document = window.document;
    document.body.innerHTML = `
      <div class="detailPanel">
        <button id="viewDetailsToggle" type="button">View details</button>
      </div>
    `;

    let currentUrl = BASE_URL;
    const currentTitle = "Profile";

    const page: Page = {
      evaluate: async (expr: unknown): Promise<unknown> => {
        const src = String(expr);
        const fn = new window.Function("document", "XPathResult", `return (${src});`) as (
          d: unknown,
          x: unknown
        ) => unknown;
        return fn(document, { FIRST_ORDERED_NODE_TYPE: 9 });
      },
      url: () => currentUrl,
      title: async () => currentTitle,
      locator: () => ({
        first: () => ({
          click: async () => {},
          isChecked: async () => false,
          inputValue: async () => "",
        }),
      }),
      waitForTimeout: async () => {},
      getSessionForFrame: () => ({ on: () => {}, off: () => {} }),
      mainFrameId: () => "main",
      sendCDP: async () => ({ body: "{}", base64Encoded: false }),
    } as unknown as Page;

    const stagehand: Stagehand = {
      // Stagehand's own act() drives the click internally — modeled here by
      // having the mock perform the SAME side effect a real "View details"
      // toggle handler would: a redirect/round-trip that stamps a transient
      // request-id query param onto the identical origin+path, with no DOM
      // mutation and no network signal.
      act: vi.fn().mockImplementation(async () => {
        currentUrl = POST_CLICK_URL;
        return {
          success: true,
          message: "clicked",
          actionDescription: TOGGLE_STEP,
          actions: [
            {
              selector: "#viewDetailsToggle",
              description: "View details",
              method: "click",
            },
          ],
        };
      }),
      observe: vi.fn().mockImplementation(async (instruction?: unknown) =>
        typeof instruction === "string"
          ? [
              {
                selector: "#viewDetailsToggle",
                description: "View details",
                method: "click",
              },
            ]
          : []
      ),
    } as unknown as Stagehand;

    // Unflagged, single-step flow — mirrors the report's bridge step that
    // never carries submitStep:true. Single-step keeps the assertion
    // unambiguous: any credit of THIS step (correct or buggy) directly
    // decides whether the flow resolves or rejects, with no second step's
    // own independent failure able to mask it.
    const STEPS: HealingFlowStep[] = [
      { instruction: TOGGLE_STEP, optional: false, upload: false, submitStep: false },
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

    // The click's own side effect did fire — the URL really did change — but
    // since the change is confined to the query string on the same
    // origin+path, it must never surface as a verifiedBy=url credit.
    expect(currentUrl).toBe(POST_CLICK_URL);
    expect(stagehand.act).toHaveBeenCalled();
  });
});
