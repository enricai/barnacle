import { runInNewContext } from "node:vm";

import {
  locatorScriptBootstrap,
  locatorScriptGlobalRefs,
  locatorScriptSources,
} from "@browserbasehq/stagehand/lib/v3/dom/build/locatorScripts.generated.js";
import type { Frame } from "@browserbasehq/stagehand/lib/v3/understudy/frame.js";
import { Locator } from "@browserbasehq/stagehand/lib/v3/understudy/locator.js";
import { FrameSelectorResolver } from "@browserbasehq/stagehand/lib/v3/understudy/selectorResolver.js";
import { describe, expect, it, vi } from "vitest";

import {
  buildDenseFormFixture,
  DENSE_FORM_TARGET_TEXT,
  type FakeDomRoot,
} from "@/scraper/deep-locator-fake";
import {
  buildScanFrameCandidatesExpr,
  type FrameCandidateScanResult,
  INTERACTIVE_CANDIDATE_SELECTOR,
} from "@/scraper/deep-locator-scan";

/**
 * Installed `@browserbasehq/stagehand` version every assertion below was
 * verified against (package.json floats `^3.6.0`) — re-verify this file
 * against `node_modules/@browserbasehq/stagehand/package.json`'s `version`
 * whenever the lockfile bumps it, since these contracts live in Stagehand's
 * own minified source, not in a type-checked public API.
 */
const VERIFIED_STAGEHAND_VERSION = "3.7.0";

/**
 * Executes a generated expression string against a fake `document` bound as
 * global `document` — mirrors `deep-locator-scan.dense-form.test.ts`'s own
 * harness so this file proves the Stagehand-side half of the contract
 * against the IDENTICAL fixture, not a reimplementation of it.
 */
function evaluateInFakePage(expr: string, document: FakeDomRoot): unknown {
  return runInNewContext(expr, {
    document,
    getComputedStyle: (el: { computedStyle: unknown }) => el.computedStyle,
    console,
  });
}

/**
 * Invokes the installed package's OWN `resolveCssSelector` — the same
 * generated bootstrap + global-ref invocation shape
 * `FrameSelectorResolver.buildLocatorInvocation` builds in
 * `selectorResolver.js` (`return \`(() => { ${locatorScriptBootstrap}; return ${call}; })()\``)
 * — against `root`, so this pin runs Stagehand's real primary CSS resolver
 * rather than a description of it.
 */
function resolveViaStagehand(selector: string, index: number, root: FakeDomRoot): unknown {
  const invocation = `${locatorScriptGlobalRefs.resolveCssSelector}(${JSON.stringify(selector)}, ${index})`;
  const expr = `(() => { ${locatorScriptBootstrap}; return ${invocation}; })()`;
  return evaluateInFakePage(expr, root);
}

const FAKE_FRAME_ID = "fake-frame-actuation-contract";
const ISOLATED_WORLD_CONTEXT_ID = 4001;
const MAIN_WORLD_CONTEXT_ID = 4002;

/**
 * Builds the `{ result: { value } }` `Runtime.callFunctionOn` reply
 * `fill`/`selectOption`/`inputValue` each expect, keyed off the SAME
 * `functionDeclaration` reference/inline-snippet the installed Locator
 * actually sends — so a declaration change in a future Stagehand bump makes
 * this throw instead of silently returning the wrong shape.
 */
function resolveCallFunctionOnResponse(params: unknown): { result: { value: unknown } } {
  const { functionDeclaration } = params as { functionDeclaration: string };
  if (functionDeclaration === locatorScriptSources.selectElementOptions) {
    return { result: { value: ["pinned-option"] } };
  }
  if (functionDeclaration === locatorScriptSources.readElementInputValue) {
    return { result: { value: "pinned-input-value" } };
  }
  if (functionDeclaration.includes(locatorScriptGlobalRefs.fillElementValue)) {
    return { result: { value: { status: "done" } } };
  }
  throw new Error(
    `unexpected Runtime.callFunctionOn declaration in actuation index-cost contract test: ${functionDeclaration.slice(0, 80)}`
  );
}

/**
 * A stub CDP session counting `Runtime.evaluate` sends — the round-trip
 * `FrameSelectorResolver.resolveCss` (selectorResolver.js:79-115) issues once
 * per index while scanning up to `limit`. `on()` delivers
 * `Runtime.executionContextCreated` synchronously the moment
 * `waitForMainWorld` subscribes (selectorResolver.js's own `ctxId` lookup,
 * unconditionally awaited before the resolve loop even when the primary path
 * never needs it), so the resolver never falls through to its 1000ms
 * fallback timeout.
 */
interface CountingFrameSession {
  send: (method: string, params?: unknown) => Promise<unknown>;
  on: (event: string, handler: (params: unknown) => void) => void;
  off: (event: string, handler: (params: unknown) => void) => void;
}

function makeCountingFrameSession(): {
  session: CountingFrameSession;
  evaluateCallCount: () => number;
} {
  let evaluateCalls = 0;
  const send = async (method: string, params?: unknown): Promise<unknown> => {
    switch (method) {
      case "Runtime.enable":
      case "DOM.enable":
        return {};
      case "Page.createIsolatedWorld":
        return { executionContextId: ISOLATED_WORLD_CONTEXT_ID };
      case "Runtime.evaluate":
        evaluateCalls += 1;
        return { result: { objectId: `resolved-node-${evaluateCalls}` } };
      case "DOM.requestNode":
        return { nodeId: evaluateCalls };
      case "Runtime.callFunctionOn":
        return resolveCallFunctionOnResponse(params);
      case "Runtime.releaseObject":
        return {};
      default:
        throw new Error(`unexpected CDP call in actuation index-cost contract test: ${method}`);
    }
  };
  const on = (event: string, handler: (params: unknown) => void): void => {
    if (event !== "Runtime.executionContextCreated") return;
    handler({
      context: { id: MAIN_WORLD_CONTEXT_ID, auxData: { isDefault: true, frameId: FAKE_FRAME_ID } },
    });
  };
  return {
    session: { send, on, off: () => {} },
    evaluateCallCount: () => evaluateCalls,
  };
}

/** Casts through `unknown` because the installed `Frame` class carries a private field, so no plain object is structurally assignable to it. */
function makeFakeFrame(session: unknown): Frame {
  return { session, frameId: FAKE_FRAME_ID, pageId: "fake-page" } as unknown as Frame;
}

describe(`Stagehand ${VERIFIED_STAGEHAND_VERSION} resolver contracts the batched-scan fix depends on`, () => {
  it("resolveCssSelector(sel, index) resolves the SAME element buildScanFrameCandidatesExpr reported at that index, for every surviving candidate after visibility filtering — verified against the installed Stagehand 3.7.0", () => {
    const { root } = buildDenseFormFixture();
    const expectedMatches = root.querySelectorAll(INTERACTIVE_CANDIDATE_SELECTOR);

    const scanResults = evaluateInFakePage(
      buildScanFrameCandidatesExpr(INTERACTIVE_CANDIDATE_SELECTOR),
      root
    ) as FrameCandidateScanResult[];
    const visibleCandidates = scanResults.filter((candidate) => candidate.visible);
    const droppedIndices = scanResults
      .filter((candidate) => !candidate.visible)
      .map((candidate) => candidate.index);

    // The fixture's two unrendered decoys sit before the visible target button
    // in document order, so this run exercises a real index gap (not just a
    // contiguous 0..n-1 range) — the exact "visibility filtering drops
    // earlier indices" case the contract must hold under.
    expect(droppedIndices.length).toBeGreaterThan(0);
    expect(Math.max(...droppedIndices)).toBeLessThan(
      Math.max(...visibleCandidates.map((candidate) => candidate.index))
    );

    for (const candidate of visibleCandidates) {
      const expected = expectedMatches[candidate.index];
      expect(expected).toBeDefined();
      // Stagehand 3.7.0's resolveCssSelector(sel, i) = querySelectorAll(sel)[i]
      // in the frame's own document (selectorResolver.js's `Y`/`Ct` helpers) —
      // the same resolution deepLocator(hop).nth(index) ultimately reaches.
      const resolved = resolveViaStagehand(INTERACTIVE_CANDIDATE_SELECTOR, candidate.index, root);
      expect(resolved).toBe(expected);
    }
  });

  it("resolves the icon-only target button's scan-reported index to the target element itself, not merely to `a`-matching-object of the same shape — Stagehand 3.7.0", () => {
    const { root } = buildDenseFormFixture();
    const scanResults = evaluateInFakePage(
      buildScanFrameCandidatesExpr(INTERACTIVE_CANDIDATE_SELECTOR),
      root
    ) as FrameCandidateScanResult[];
    const targetCandidate = scanResults.find(
      (candidate) => candidate.text === DENSE_FORM_TARGET_TEXT
    );
    expect(targetCandidate).toBeDefined();
    if (!targetCandidate) throw new Error("unreachable: asserted defined above");

    // Stagehand 3.7.0: resolveCssSelector returns the live element, so its
    // own aria-label still reads back through the resolved reference.
    const resolved = resolveViaStagehand(
      INTERACTIVE_CANDIDATE_SELECTOR,
      targetCandidate.index,
      root
    ) as { getAttribute(name: string): string | null };
    expect(resolved.getAttribute("aria-label")).toBe(DENSE_FORM_TARGET_TEXT);
  });

  it("FrameSelectorResolver.parseSelector keeps a comma-bearing selector as one css query verbatim when it carries no '>>' hop — Stagehand 3.7.0", () => {
    const parsed = FrameSelectorResolver.parseSelector(INTERACTIVE_CANDIDATE_SELECTOR);
    expect(parsed).toEqual({ kind: "css", value: INTERACTIVE_CANDIDATE_SELECTOR });
  });

  it("FrameSelectorResolver.parseSelector rewrites a '>>'-bearing selector by space-joining its hops, losing frame-scoping — pinning why INTERACTIVE_CANDIDATE_SELECTOR must stay the FINAL hop segment (verified against Stagehand 3.7.0)", () => {
    const hopNotation = `iframe#id >> ${INTERACTIVE_CANDIDATE_SELECTOR}`;
    const parsed = FrameSelectorResolver.parseSelector(hopNotation);
    expect(parsed).toEqual({
      kind: "css",
      value: `iframe#id ${INTERACTIVE_CANDIDATE_SELECTOR}`,
    });
    expect(parsed.value).not.toBe(hopNotation);
  });
});

describe(`Stagehand ${VERIFIED_STAGEHAND_VERSION} FrameSelectorResolver.resolveAtIndex pays index + 1 serial Runtime.evaluate round-trips`, () => {
  it.each([0, 1, 5, 12])(
    "resolveAtIndex(cssQuery, %i) issues exactly index + 1 Runtime.evaluate sends and resolves a node",
    async (index) => {
      const { session, evaluateCallCount } = makeCountingFrameSession();
      const resolver = new FrameSelectorResolver(makeFakeFrame(session));
      const query = FrameSelectorResolver.parseSelector(INTERACTIVE_CANDIDATE_SELECTOR);

      const resolved = await resolver.resolveAtIndex(query, index);

      expect(resolved).not.toBeNull();
      expect(evaluateCallCount()).toBe(index + 1);
    }
  );
});

describe(`Stagehand ${VERIFIED_STAGEHAND_VERSION} Locator.fill/selectOption/inputValue route through resolveNode() -> FrameSelectorResolver.resolveAtIndex(query, index)`, () => {
  it.each([
    { method: "fill", index: 0 },
    { method: "fill", index: 6 },
    { method: "selectOption", index: 4 },
    { method: "selectOption", index: 11 },
    { method: "inputValue", index: 9 },
  ] as const)(
    "Locator.nth($index).$method() resolves via exactly one resolveNode() call, costing index + 1 Runtime.evaluate sends",
    async ({ method, index }) => {
      const { session, evaluateCallCount } = makeCountingFrameSession();
      const resolveNodeSpy = vi.spyOn(Locator.prototype, "resolveNode");
      const locator = new Locator(makeFakeFrame(session), INTERACTIVE_CANDIDATE_SELECTOR, {}).nth(
        index
      );

      if (method === "fill") await locator.fill("pinned-value");
      else if (method === "selectOption") await locator.selectOption("pinned-option");
      else await locator.inputValue();

      expect(resolveNodeSpy).toHaveBeenCalledTimes(1);
      expect(evaluateCallCount()).toBe(index + 1);
      resolveNodeSpy.mockRestore();
    }
  );
});
