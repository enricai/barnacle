import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { type HealingFlowStep, runHealingFlow } from "@/scraper/flow-runner";
import type { Logger } from "@/types/logging";

/**
 * Generalization regression for
 * recon-browser-1.12.54-phantom-click-verdict-inconsistent-blocks-terminal-tab-toggle-steps-from-ever-completing.md:
 * the fix that lets an `"effective"` `classifyPhantomClick` verdict terminate
 * the retry cascade must not be scoped to the final/submit-shaped branch (a
 * narrow patch of `isClickViewSwapVerified`'s own exclusion would only cover
 * that shape). This pins the SAME defect class on an ORDINARY INTERIOR step —
 * `isFinalStep=false`, `submitStep=false`, no flow-level submit pattern — so
 * a fix scoped only to the final-step exclusion would leave this case
 * cascading forever.
 *
 * Fixture shape, deliberately landing strictly in the gap `isClickViewSwapVerified`
 * itself leaves open (flow-runner.ts:1793-1819): a listing-page filter chip
 * whose toggle grows the body by ~700B — past the phantom-click trivial floor
 * (`TRIVIAL_DOM_DELTA_BYTES`, 500B) but under the view-swap floor
 * (`VIEW_SWAP_MIN_BYTES`, 5000B) — with the growth entirely inside a `hidden`
 * node, so `visibleTextSignature` (and hence `textChanged`) never moves and
 * the view-swap gate's `textChanged && bytesDelta >= VIEW_SWAP_REVEAL_MIN_BYTES`
 * reveal carve-out can't independently credit it either. The chip also never
 * writes any tracked ARIA/class/data-state fingerprint field, so
 * `verifyDomEffect`'s element-scoped `domVerified` signal stays false too —
 * isolating completion entirely to the phantomClickVerdict-driven fix's
 * page-wide byte-delta branch, exercised here through the n+16 `el.click()`
 * fallback (flow-runner.ts around line 11660's `retryVerdict`), the same
 * primitive `classifyPhantomClick` uses for the primary gate.
 *
 * Attempt 1 resolves via Stagehand's raw `act(instruction)` string call,
 * which reports no actionable candidate at all (a real "wrong/inert" outcome
 * for the raw string — Stagehand's own act() resolution frequently misses a
 * generic, unlabeled filter chip that only `observe()`'s ranked-candidate
 * pass finds) — this keeps attempt 1's phantom-click verdict `"unresolved"`
 * (not `"phantom"`), so attempt 2 escalates to `observe-act` rather than
 * `trusted-click-retry` (the escalation reserved for an ACTUAL phantom click
 * on attempt 1) — `trusted-click-retry` re-clicks via a Playwright locator or
 * deepLocator primitive and never calls `stagehand.act` again, which would
 * make the "exactly 2 act calls" assertion below unsatisfiable. Attempt 2's
 * `observe()` finds the real chip and `act()`s on it — landing the byte-delta
 * growth this test pins.
 *
 * Site-agnostic fixture: a generic product-listing filter chip, not any real
 * site or plugin.
 *
 * Runs the real production expressions (`SELECTION_STATE_MAP_EXPR`,
 * `elementSelectionFingerprintExpr`, `DOM_SNAPSHOT_EXPR`, the n+16 fallback's
 * own click-activation expression) against a live happy-dom document via
 * `window.Function`, mirroring
 * `flow-runner.pricing-tab-symmetric-swap-verdict-acceptance.test.ts` — no
 * internal helper is hand-simulated, only the DOM shape and the chip's own
 * click handler.
 */

const BASE_URL = "https://shop.example.com/catalog/sneakers";

const FILTER_CHIP_STEP = "Toggle the 'In Stock' filter chip on the listing page";
const SORT_CHIP_STEP = "Toggle the 'Price: Low to High' sort chip";

const SILENT_LOGGER_CALLS = { info: [] as string[], warn: [] as string[] };
const testLogger = {
  info: vi.fn((msg: string) => SILENT_LOGGER_CALLS.info.push(msg)),
  warn: vi.fn((msg: string) => SILENT_LOGGER_CALLS.warn.push(msg)),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

/** Mirrors Stagehand's `nodeToAbsoluteXPath`: pure tag+sibling-position steps. */
function absoluteXPathFor(el: HappyDomElement): string {
  const steps: string[] = [];
  let node: HappyDomElement | null = el;
  while (node) {
    const currentNode: HappyDomElement = node;
    const parent: HappyDomElement | null = currentNode.parentElement;
    if (!parent) {
      steps.unshift(`${currentNode.tagName.toLowerCase()}[1]`);
      break;
    }
    const sameTag = Array.from(parent.children).filter(
      (c: HappyDomElement) => c.tagName === currentNode.tagName
    );
    const idx = sameTag.indexOf(currentNode) + 1;
    steps.unshift(`${node.tagName.toLowerCase()}[${idx}]`);
    node = parent;
  }
  return `/${steps.join("/")}`;
}

function resolveAbsoluteXPath(root: HappyDomElement, xp: string): HappyDomElement | null {
  const steps = xp
    .split("/")
    .filter(Boolean)
    .map((step) => {
      const match = /^([a-zA-Z0-9]+)\[(\d+)\]$/.exec(step);
      if (!match) throw new Error(`unsupported xpath step in test fixture: ${step}`);
      return { tag: match[1]?.toUpperCase(), idx: Number(match[2]) };
    });
  let current: HappyDomElement | null = root;
  for (const step of steps.slice(1)) {
    if (!current) return null;
    const candidates: HappyDomElement[] = Array.from(current.children).filter(
      (c: HappyDomElement) => c.tagName === step.tag
    );
    current = candidates[step.idx - 1] ?? null;
  }
  return current;
}

function describeActInput(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input);
  } catch {
    return "";
  }
}

describe("flow-runner effective-verdict-terminates-cascade on an interior (non-final, non-submit) step (offline fixture, live happy-dom, no network)", () => {
  it("stops the cascade at attempt 2 once the n+16 fallback's page-wide byte-delta lands an effective verdict, on a step that is neither final nor submit-shaped", async () => {
    const window = new Window({ url: BASE_URL });
    const document = window.document;
    document.body.innerHTML = `
      <div class="listingFilters">
        <button id="promoLink">See today's promo</button>
        <button id="filterChip">In Stock</button>
        <div role="listbox">
          <input type="hidden" id="sortChipState" />
        </div>
      </div>
    `;

    const promoLinkEl = document.getElementById("promoLink") as unknown as HappyDomElement;
    const filterChipEl = document.getElementById("filterChip") as unknown as HappyDomElement;
    const sortChipEl = document.getElementById("sortChipState") as unknown as HappyDomElement;
    expect(promoLinkEl).not.toBeNull();
    expect(filterChipEl).not.toBeNull();
    expect(sortChipEl).not.toBeNull();

    const filterChipXPath = absoluteXPathFor(filterChipEl);
    const sortChipXPath = absoluteXPathFor(sortChipEl);

    // Grown entirely inside a `hidden` attribute-carried node — invisible to
    // `innerText`, so `visibleTextSignature` (and `textChanged`) never moves.
    // 700B clears the phantom-click trivial floor (500B) but stays well under
    // the view-swap floor (5000B), landing strictly in the gap neither
    // `isClickViewSwapVerified` branch (>=5000B, or 500B+textChanged) covers.
    const CHIP_PADDING = "x".repeat(700);

    // The "wrong/inert candidate" attempt-1 target: a promo link with a
    // click handler that produces zero observable effect at all.
    let promoLinkClickCalls = 0;
    (
      promoLinkEl as unknown as {
        addEventListener: (type: string, cb: (ev: unknown) => void) => void;
      }
    ).addEventListener("click", () => {
      promoLinkClickCalls += 1;
    });

    // The real toggle: grows the body by ~700B via a hidden node, writes NO
    // tracked ARIA/class/data-state fingerprint field on itself (so
    // `verifyDomEffect`'s element-scoped `domVerified` signal stays false),
    // and is idempotent (a second click — the n+16 fallback's own native
    // re-click of the same resolved element — adds nothing further), so the
    // total growth relative to the attempt's own `pre` snapshot stays inside
    // the [500B, 5000B) gap regardless of how many times the handler fires.
    let filterChipClickCalls = 0;
    (
      filterChipEl as unknown as {
        addEventListener: (type: string, cb: (ev: unknown) => void) => void;
      }
    ).addEventListener("click", () => {
      filterChipClickCalls += 1;
      if (document.getElementById("chipPadding")) return;
      const pad = document.createElement("div");
      pad.setAttribute("id", "chipPadding");
      pad.setAttribute("hidden", "true");
      pad.setAttribute("data-pad", CHIP_PADDING);
      document.body.appendChild(pad);
    });

    // The flow's second (final) step: an ordinary same-page sort-chip toggle
    // that commits its own tracked fingerprint field, so it verifies on
    // attempt 1 via the existing element-scoped `domVerified` credit — not
    // itself under test here, just what advances `lastStepIndex` to 1 so the
    // assertion below can confirm the flow didn't get stuck on step 0.
    let sortChipClickCalls = 0;
    (
      sortChipEl as unknown as {
        addEventListener: (type: string, cb: (ev: unknown) => void) => void;
      }
    ).addEventListener("click", () => {
      sortChipClickCalls += 1;
      sortChipEl.setAttribute("data-selected", "true");
    });

    const documentElement = document.documentElement as unknown as HappyDomElement;
    const win = window as unknown as { XPathResult?: unknown };
    win.XPathResult = { FIRST_ORDERED_NODE_TYPE: 9 };
    (document as unknown as { evaluate: (expr: string) => { singleNodeValue: unknown } }).evaluate =
      (expr: string) => {
        const node = expr.startsWith("//") ? null : resolveAbsoluteXPath(documentElement, expr);
        return { singleNodeValue: node };
      };

    const session = { on: () => {}, off: () => {} };
    // Every production `page.evaluate` expression (the selection baseline
    // map, the element-scoped fingerprint read-back, the DOM snapshot, the
    // n+16 fallback's own click-activation expression) is executed FOR REAL
    // against the live document via `window.Function` — nothing here
    // hand-simulates flow-runner.ts's internal verification logic.
    const page: Page = {
      evaluate: async (expr: unknown): Promise<unknown> => {
        const src = String(expr);
        const fn = new window.Function("document", "XPathResult", `return (${src});`) as (
          d: unknown,
          x: unknown
        ) => unknown;
        return fn(document, win.XPathResult);
      },
      url: () => BASE_URL,
      title: async () => "Sneakers | Catalog",
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

    const stagehand: Stagehand = {
      // Attempt 1 of the filter-chip step calls `act(FILTER_CHIP_STEP)` (a
      // raw string) — Stagehand's own resolution finds nothing actionable
      // for this generic, unlabeled chip, so this returns failure, keeping
      // attempt 1's classifyPhantomClick verdict "unresolved" (not
      // "phantom") and routing attempt 2 to observe-act rather than
      // trusted-click-retry. The sort-chip step's own raw-string act call
      // DOES resolve (a real site's Stagehand call succeeding on an
      // unambiguous, well-labeled control), completing that step on attempt
      // 1 with no escalation needed.
      act: vi.fn().mockImplementation(async (input: unknown) => {
        const description = describeActInput(input);
        if (typeof input === "string" && input === FILTER_CHIP_STEP) {
          return {
            success: false,
            message: "no actionable candidate",
            actionDescription: "",
            actions: [],
          };
        }
        if (description.includes("filterChip") || description.includes("In Stock")) {
          return {
            success: true,
            message: "clicked",
            actionDescription: "Clicked the 'In Stock' filter chip",
            actions: [
              {
                selector: `xpath=${filterChipXPath}`,
                description: "In Stock filter chip",
                method: "click",
              },
            ],
          };
        }
        if (typeof input === "string" && input === SORT_CHIP_STEP) {
          return {
            success: true,
            message: "clicked",
            actionDescription: SORT_CHIP_STEP,
            actions: [
              {
                selector: `xpath=${sortChipXPath}`,
                description: "Price sort chip",
                method: "click",
              },
            ],
          };
        }
        return {
          success: false,
          message: "no actionable candidate",
          actionDescription: description,
          actions: [],
        };
      }),
      // Focused observe() only ever surfaces the REAL filter chip for the
      // filter-chip step — never the promo-link decoy — matching the
      // report's "attempt 2 finds the genuine control" shape. The sort-chip
      // step's own focused observe (used only by the pre-attempt presence
      // probe, since that step completes via its raw-string act() call)
      // and the presence probe's unfocused (`undefined` instruction) pass
      // both resolve too, so neither step's probe misreports "absent".
      observe: vi.fn().mockImplementation(async (instruction?: unknown) => {
        if (instruction === undefined) {
          return [
            {
              selector: `xpath=${filterChipXPath}`,
              description: "In Stock filter chip",
              method: "click",
            },
          ];
        }
        if (instruction === FILTER_CHIP_STEP) {
          return [
            {
              selector: `xpath=${filterChipXPath}`,
              description: "In Stock filter chip",
              method: "click",
            },
          ];
        }
        if (instruction === SORT_CHIP_STEP) {
          return [
            {
              selector: `xpath=${sortChipXPath}`,
              description: "Price sort chip",
              method: "click",
            },
          ];
        }
        return [];
      }),
    } as unknown as Stagehand;

    const TOGGLE_STEPS: HealingFlowStep[] = [
      { instruction: FILTER_CHIP_STEP, optional: false, upload: false, submitStep: false },
      { instruction: SORT_CHIP_STEP, optional: false, upload: false, submitStep: false },
    ];

    // No step is flagged `submitStep`, and the flow declares no
    // `submitEndpointPattern`/`requireSubmitEndpointMatch` — a genuinely
    // read-only flow, so `flowHasSubmitSemantics` is false and the filter
    // chip (the flow's FIRST step, not its final one) is unambiguously
    // interior and non-submit-shaped.
    const result = await runHealingFlow({
      stagehand,
      page,
      steps: TOGGLE_STEPS,
      logger: testLogger,
      anthropic: null,
      rephraseModel: null,
      uploadFixture: null,
      submitEndpointPattern: null,
      requireSubmitEndpointMatch: false,
    });

    expect(result.lastStepIndex).toBe(1);

    // The decoy never produced any effect; the real chip fired via its own
    // handler at least once (the primary act() click and/or the n+16
    // fallback's native re-click — idempotent, so either count is correct).
    expect(promoLinkClickCalls).toBe(0);
    expect(filterChipClickCalls).toBeGreaterThanOrEqual(1);
    expect(sortChipClickCalls).toBe(1);

    // The exact defect under test: attempt 1 (raw-string act, no candidate)
    // plus attempt 2 (observe finds the real chip, act() clicks it) — never
    // a 3rd attempt on this step.
    const filterChipActCalls = (
      stagehand.act as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.filter((call) => {
      const arg = call[0];
      const desc = describeActInput(arg);
      return arg === FILTER_CHIP_STEP || desc.includes("filterChip") || desc.includes("In Stock");
    });
    expect(filterChipActCalls).toHaveLength(2);

    // The chip's own committed state never gained a tracked ARIA/class/
    // data-state fingerprint field — `verifyDomEffect`'s element-scoped
    // domVerified signal genuinely never fires for this step.
    expect(filterChipEl.getAttribute("data-selected")).toBeNull();
    expect(filterChipEl.getAttribute("aria-pressed")).toBeNull();

    // Never escalated past attempt 2 (no attempt-3+ log line, no replan).
    const allLogged = [...SILENT_LOGGER_CALLS.info, ...SILENT_LOGGER_CALLS.warn].join("\n");
    expect(allLogged).not.toContain("attempt 3");
    expect(allLogged).not.toContain("attempt 4");
    expect(allLogged).not.toContain("attempt 5");

    // The n+16 fallback's own probe line proves the byte-delta landed
    // strictly in the isClickViewSwapVerified gap (500B <= delta < 5000B)
    // with no text change and no selection-state change — the ONLY signal
    // available is the effective-verdict-driven credit under test.
    const n16ProbeLine = SILENT_LOGGER_CALLS.info.find((line) => line.includes("n+16 probe:"));
    expect(n16ProbeLine).toBeDefined();
    expect(n16ProbeLine).toContain("textChanged=false");
    expect(n16ProbeLine).toContain("selectionStateChanged=false");
    expect(n16ProbeLine).toContain("verified=true");
    const htmlDeltaMatch = n16ProbeLine ? /htmlDelta=(-?\d+)/.exec(n16ProbeLine) : null;
    const htmlDelta = htmlDeltaMatch ? Number(htmlDeltaMatch[1]) : Number.NaN;
    expect(htmlDelta).toBeGreaterThanOrEqual(500);
    expect(htmlDelta).toBeLessThan(5000);

    // Healed on attempt 2 — not attempt 1, and not by burning further
    // attempts before completing.
    expect(SILENT_LOGGER_CALLS.info.some((line) => line.includes("healed on attempt 2"))).toBe(
      true
    );
  });
});
