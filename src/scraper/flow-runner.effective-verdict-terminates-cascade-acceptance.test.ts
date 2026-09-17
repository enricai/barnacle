import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { describe, expect, it, vi } from "vitest";
import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Pins the report's precise defect: `classifyPhantomClick`'s verdict used to
 * be computed only for diagnostics/escalation AFTER the narrower `verified`
 * gate had already failed the attempt — nothing checked an `"effective"`
 * verdict to end the retry loop.
 *
 * Fixture shape: a single, non-submit-flagged FINAL step in a flow that
 * declares no `submitEndpointPattern` and no `requireSubmitEndpointMatch`
 * (so `flowHasSubmitSemantics` is false, and — critically —
 * `requireSubmitEndpoint` is also false, since that flag alone would make
 * `weakDomSignalsAllowed` true via its own OR-term and let the PRE-EXISTING
 * raw-byte-delta signal credit this step for an unrelated reason, masking
 * the fix under test). With neither flag set, `weakDomSignalsAllowed`
 * (flow-runner.ts's n+16 fallback gate) is false purely because this is the
 * flow's only/final step, so the OLD code could not credit a page-wide
 * byte-delta at all here. Attempt 1's `stagehand.act` reports success on the resolved
 * category-tab button, but the click produces NO observable effect at all
 * (no network, no URL change, no element-fingerprint change, no DOM growth)
 * — Stagehand's own synthetic activation genuinely no-oped, forcing the
 * cascade's existing n+16 `el.click()` fallback (flow-runner.ts's in-attempt
 * "does the underlying element actually respond to a real DOM click"
 * safety-net) to fire within THIS SAME attempt. That fallback's OWN click
 * causes a structural re-render: the tab panel swaps (+700B body growth,
 * clearing `TRIVIAL_DOM_DELTA_BYTES`/500B but well under the 5000B
 * view-swap threshold, and no visible-text change so the view-swap reveal
 * credit doesn't apply either), while the re-render replaces the clicked
 * button's own DOM node, defeating the element-scoped fingerprint match (no
 * `domVerified` credit). `classifyPhantomClick` still classifies this
 * `"effective"` via its page-wide byte-floor branch alone.
 *
 * **What this pins:** `stagehand.act` is called exactly once — the cascade
 * must recognize the n+16 fallback's own effective verdict and complete the
 * step WITHOUT ever escalating to attempt 2 (`stagehand.observe`+`act`),
 * attempt 3 (`structured-click`), attempt 4, or attempt 5 (`llm-rephrase`).
 * No "failed after 5 attempts" / cascade-exhaustion log fires.
 *
 * **Why not the literal flow-level-`submitEndpointPattern` final-step shape
 * described in this subtask's seed:** setting `submitEndpointPattern`
 * non-null on a final step also flips `requireSubmitEndpoint` true (per
 * `requireSubmitEndpoint`'s own definition), which independently makes
 * `weakDomSignalsAllowed` true and lets the PRE-EXISTING raw
 * `retryHtmlDelta !== 0` OR-term credit the byte delta for a reason that has
 * nothing to do with this fix (confirmed empirically: that variant already
 * verified — via the old weak-signal path — before and after commit
 * a070c32, so it exercises no new behavior). This fixture instead keeps
 * `flowHasSubmitSemantics` false while still being an `isFinalStep` step, so
 * `weakDomSignalsAllowed` is false for the one reason this fix's byte-floor
 * OR-term (`retryVerdict === "effective"`) actually matters: a final step
 * with no submit semantics still can't ride the raw weak-signal path, but
 * classifyPhantomClick's byte-floor verdict now closes that gap. Falsified
 * by re-running this exact fixture against `flow-runner.ts` as of commit
 * a070c32~1: the assertions below fail there — `retryVerified` stays
 * `false` (`htmlDelta=700 ... verified=false` in the n+16 probe log) and the
 * cascade exhausts all 5 attempts, throwing `StepVerificationError`.
 */

const TAB_STEP = "Click the 'Warranty' category tab to switch to it";
const TAB_XPATH = "/html[1]/body[1]/div[1]/button[2]";
const TAB_SELECTOR = `xpath=${TAB_XPATH}`;

interface CapturedLogs {
  info: string[];
  warn: string[];
}

function makeCapturingLogger(): { logger: Logger; captured: CapturedLogs } {
  const captured: CapturedLogs = { info: [], warn: [] };
  const logger = {
    info: (msg: string) => {
      captured.info.push(msg);
    },
    warn: (msg: string) => {
      captured.warn.push(msg);
    },
    error: () => {},
    debug: () => {},
  } as unknown as Logger;
  return { logger, captured };
}

/** In-memory model of the tab panel's re-render, driven by the n+16 fallback's own click. */
interface AcceptanceSequenceState {
  /** Flips true only once the n+16 `el.click()` fallback's expression runs. */
  fallbackClickFired: boolean;
}

/** Matches the toggle acceptance fixtures: a plain top-window Page fake, no OOPIF hop. */
function makeTabPage(state: AcceptanceSequenceState): Page {
  const session = { on: () => {}, off: () => {} };
  return {
    evaluate: async (expr: unknown) => {
      const src = String(expr);
      // snapshotPage's DOM_SNAPSHOT_EXPR probe. Body grows +700B — clears
      // TRIVIAL_DOM_DELTA_BYTES (500B) but stays under the 5000B view-swap
      // floor — only once the fallback's own click has re-rendered the panel.
      // Visible text length is unchanged so the view-swap reveal credit
      // (which additionally requires textChanged) never applies either.
      if (src.includes("outerHTML") && src.includes("innerText")) {
        return state.fallbackClickFired
          ? { html: 40_700, text: "500:catalog" }
          : { html: 40_000, text: "500:catalog" };
      }
      // verifyDomEffect's / the n+16 fallback's disabled-target veto.
      if (src.includes("isDisabled")) return false;
      // verifyDomEffect's click-branch input-type probe — a category tab
      // <button>, not a native radio/checkbox.
      if (src.includes("el.type || null")) return null;
      // ng-invalid marker count (pre/post veto input) — none on this page.
      if (src.includes('querySelectorAll("[class],[aria-invalid]")')) return 0;
      // The n+16 fallback's own `el.click()` expression: resolves the SAME
      // xpath act-string clicked, but this is a REAL DOM click.dispatchEvent
      // sequence (not Stagehand's synthetic activation), which genuinely
      // re-renders the panel here. The re-render replaces the clicked
      // button's own node, so no per-xpath selection fingerprint carries
      // over — no `domVerified`/`retrySelectionStateChanged` credit, only
      // the page-wide byte delta above.
      if (src.includes("__n16SmMatched")) {
        state.fallbackClickFired = true;
        return { fired: true, kind: "click" };
      }
      // Every SELECTION_STATE_MAP_EXPR / elementSelectionFingerprintExpr /
      // selectionAncestorChanged / selectionSiblingCommittedValueChanged read
      // defaults to no baseline / no match — the structural re-render leaves
      // nothing for the element-scoped signal to diff, by design of this
      // fixture (see the module docblock: no domVerified credit anywhere).
      return null;
    },
    url: () => "https://shop.example.com/catalog",
    title: async () => "Catalog | Category Tabs",
    locator: () => ({
      first: () => ({
        isChecked: async () => false,
        inputValue: async () => "",
      }),
    }),
    waitForTimeout: async () => {},
    getSessionForFrame: () => session,
    mainFrameId: () => "main",
    sendCDP: async () => ({ body: "{}", base64Encoded: false }),
  } as unknown as Page;
}

/**
 * Fake `Stagehand`: `act(step)` resolves the real tab button on the only
 * attempt it should ever take — its own synthetic click is a genuine no-op
 * (Stagehand reports success, but nothing on the page moves), forcing the
 * cascade's n+16 real-DOM-click fallback to fire within this same attempt.
 * `act` must never be called a second time once that fallback's own click
 * verifies effective.
 */
function makeTabStagehand(): Stagehand {
  return {
    act: vi.fn().mockImplementation(async (input: unknown) => {
      if (typeof input === "string" && input === TAB_STEP) {
        return {
          success: true,
          message: "clicked",
          actionDescription: "Clicked the 'Warranty' category tab",
          actions: [{ selector: TAB_SELECTOR, description: "Warranty tab", method: "click" }],
        };
      }
      return {
        success: false,
        message: "no actionable candidate",
        actionDescription: "",
        actions: [],
      };
    }),
    observe: vi
      .fn()
      .mockImplementation(async (instruction?: unknown) =>
        typeof instruction === "string" && instruction === TAB_STEP
          ? [{ selector: TAB_SELECTOR, description: "Warranty tab", method: "click" }]
          : []
      ),
  } as unknown as Stagehand;
}

const TAB_STEPS: HealingFlowStep[] = [
  { instruction: TAB_STEP, optional: false, upload: false, submitStep: false },
];

describe("flow-runner effective-verdict terminates cascade acceptance regression", () => {
  it("stops the cascade on attempt 1 once the n+16 fallback's own click verifies effective via the byte-floor, instead of burning attempts 2-5", async () => {
    const state: AcceptanceSequenceState = { fallbackClickFired: false };
    const stagehand = makeTabStagehand();
    const page = makeTabPage(state);
    const { logger, captured } = makeCapturingLogger();

    const result = await runHealingFlow({
      stagehand,
      page,
      steps: TAB_STEPS,
      logger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
      submitEndpointPattern: null,
      requireSubmitEndpointMatch: false,
    });

    expect(result).toMatchObject({
      submitVerified: false,
      submitStepSkipped: false,
      lastStepIndex: 0,
    });

    // The exact defect: an attempt whose n+16 fallback click is classified
    // "effective" must not spend further attempts. `act` fired exactly once.
    expect(stagehand.act).toHaveBeenCalledTimes(1);
    expect(state.fallbackClickFired).toBe(true);

    // No exhaustion/failure path was ever reached.
    const allLogs = [...captured.info, ...captured.warn];
    expect(allLogs.some((l) => l.includes("failed after 5 attempts"))).toBe(false);
    expect(allLogs.some((l) => l.includes("cascade-exhausted"))).toBe(false);
    expect(allLogs.some((l) => l.includes("phantom-click-exhausted"))).toBe(false);
  });
});
