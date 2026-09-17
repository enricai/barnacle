/**
 * Pins the report's "unbounded session/replan churn" item end-to-end,
 * through the CLI's own unstubbed `main()` step loop (recon-browser.ts) ->
 * `executeStepWithHealing` -> `classifyPhantomClick`, exactly as production
 * runs it. Mirrors `recon-browser.mid-flow-session-death.test.ts`'s
 * `main()`-driving harness (mock `@/scraper/session`'s
 * `createBrowserSession`, leave the rest of `main()` unstubbed) merged with
 * `flow-runner.pricing-tab-symmetric-swap-verdict-acceptance.test.ts`'s
 * real-expression-evaluation happy-dom fixture: `@/scraper/flow-runner` is
 * NOT mocked, so `executeStepWithHealing`, `classifyPhantomClick`, and every
 * production `page.evaluate` expression run for real against a live
 * document.
 *
 * The flow's final step is a same-page tab toggle with no submit semantics
 * anywhere (no `submitStep`, no `submitEndpointPattern`) and no tracked
 * ARIA/class/data-state selection marker, whose click SHRINKS the DOM (a
 * negative `bodyHtmlLength` delta past `TRIVIAL_DOM_DELTA_BYTES`) — the exact
 * shape bugfix-001 fixed (classifyPhantomClick/isClickViewSwapVerified were
 * both growth-only before that fix, so a shrinking-but-genuinely-effective
 * click was misclassified phantom and forced into cascade retries that ran
 * the replan budget down and could restart the session).
 *
 * Asserts, against the real end-to-end call chain: `createBrowserSession` is
 * called exactly once for the whole run (no replan-triggered second
 * session), and no logged line ever reaches the cause-based replan-budget
 * branch ("attempting global replan" / "cascade-exhausted" / "replan budget
 * exhausted").
 */

import type { Page, Stagehand } from "@browserbasehq/stagehand";
import type { Element as HappyDomElement } from "happy-dom";
import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/config", () => ({
  config: {
    scraper: {
      useBedrock: false,
      anthropicApiKey: "test-key",
      model: "anthropic/claude-sonnet-4-6",
      proxyType: "residential",
      steelSessionTimeoutMs: 30000,
      frameReadyTimeoutMs: 20_000,
      frameDocumentReadyTimeoutMs: 5_000,
      frameEvaluateTimeoutMs: 30_000,
      maxCascadeReplans: 5,
      maxProbeReplans: 5,
      maxTransportRetries: 1,
    },
    telemetry: {
      callsNdjsonPath: ".barnacle/calls.ndjson",
    },
  },
}));
vi.mock("@/lib/http", () => ({ configureHttpDispatcher: vi.fn() }));
vi.mock("@/scraper/session", () => ({ createBrowserSession: vi.fn() }));
vi.mock("@/scraper/errors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scraper/errors")>();
  return { ...actual };
});

const { loggerStub } = vi.hoisted(() => ({
  loggerStub: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    errorWithStack: vi.fn(),
  },
}));
vi.mock("@/lib/logging", () => ({
  getLogger: () => loggerStub,
  getScriptLogger: () => loggerStub,
}));

vi.mock("@/lib/telemetry/call-capture", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/telemetry/call-capture")>();
  return {
    ...actual,
    captureLlmCall: vi.fn().mockResolvedValue(undefined),
  };
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserSession } from "@/scraper/session";
import { main } from "@/scripts/recon-browser";

const BASE_URL = "https://filters.example.com/results";

const CHIP_TAB_STEP = "Click the 'In Stock' filter chip to widen results";
const TOGGLE_BACK_STEP = "Click the 'In Stock' filter chip again to narrow results";

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

function flowArgv(): string[] {
  return [
    "node",
    "recon-browser.ts",
    "--url",
    BASE_URL,
    "--flow",
    JSON.stringify([CHIP_TAB_STEP, TOGGLE_BACK_STEP]),
  ];
}

describe("recon-browser/main — effective-verdict same-page toggle never triggers global replan or a second session (bugfix-002)", () => {
  const ORIGINAL_ARGV = process.argv;
  let runsRoot: string;

  beforeEach(() => {
    runsRoot = mkdtempSync(join(tmpdir(), "recon-browser-effective-verdict-"));
    process.env.RECON_RUN_ID = "20260917-000000-effectiveverdict";
    process.env.RECON_OUT_DIR = runsRoot;
    loggerStub.info.mockClear();
    loggerStub.warn.mockClear();
    loggerStub.error.mockClear();
    vi.mocked(createBrowserSession).mockReset();
  });

  afterEach(() => {
    process.argv = ORIGINAL_ARGV;
    rmSync(runsRoot, { recursive: true, force: true });
    delete process.env.RECON_RUN_ID;
    delete process.env.RECON_OUT_DIR;
    vi.restoreAllMocks();
  });

  it("resolves via exactly one session and never touches the replan-budget branch when the final step's click shrinks the DOM", async () => {
    const window = new Window({ url: BASE_URL });
    const document = window.document;
    document.body.innerHTML = `
      <div class="filterChips">
        <button id="chipTab">In Stock</button>
        <div id="resultsPanel"></div>
      </div>
    `;

    const chipTabEl = document.getElementById("chipTab") as unknown as HappyDomElement;
    expect(chipTabEl).not.toBeNull();
    const chipXPath = absoluteXPathFor(chipTabEl);

    // Neither click leaves any ARIA/class/data-state selection marker behind
    // — every `ElementSelectionFingerprint` field stays blank on both the
    // pre- and post-click read-back, so the cascade is forced entirely onto
    // the page-wide DOM-size signal, exactly like the pricing-tab fixture
    // bugfix-001 fixed.
    const WIDEN_PADDING = "x".repeat(12_000);
    const NARROW_PADDING = "x".repeat(6_000);

    let clickCount = 0;
    (
      chipTabEl as unknown as {
        addEventListener: (type: string, cb: (ev: unknown) => void) => void;
      }
    ).addEventListener("click", () => {
      clickCount += 1;
      const panel = document.getElementById("resultsPanel");
      if (!panel) return;
      // First click widens the results panel (+12000B); second click
      // narrows it back down (-6000B) — the shrinking direction bugfix-001's
      // magnitude-based delta check was needed for.
      panel.innerHTML =
        clickCount === 1
          ? `<div data-results="${WIDEN_PADDING}"></div>`
          : `<div data-results="${NARROW_PADDING}"></div>`;
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
    // Every production `page.evaluate` expression (selection baseline map,
    // element-scoped fingerprint read-back, disabled-target veto, DOM
    // snapshot, SPA-readiness body-length probe) runs FOR REAL against the
    // live document via `window.Function`.
    const page: Page = {
      goto: vi.fn().mockResolvedValue(undefined),
      evaluate: async (expr: unknown): Promise<unknown> => {
        const src = String(expr);
        const fn = new window.Function("document", "XPathResult", `return (${src});`) as (
          d: unknown,
          x: unknown
        ) => unknown;
        return fn(document, win.XPathResult);
      },
      url: () => BASE_URL,
      title: async () => "Filtered results",
      locator: () => ({
        first: () => ({
          isChecked: async () => false,
          inputValue: async () => "",
        }),
      }),
      waitForTimeout: async () => {},
      frames: vi.fn().mockReturnValue([]),
      getSessionForFrame: () => session,
      mainFrameId: () => "main",
      sendCDP: vi.fn().mockResolvedValue({ cookies: [] }),
    } as unknown as Page;

    const stagehand: Stagehand = {
      context: { awaitActivePage: async (): Promise<Page> => page },
      act: vi.fn().mockImplementation(async (input: unknown) => {
        const description = describeActInput(input);
        if (description.includes("In Stock")) {
          return {
            success: true,
            message: "clicked",
            actionDescription: description,
            actions: [
              {
                selector: `xpath=${chipXPath}`,
                description: "In Stock filter chip",
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
      observe: vi
        .fn()
        .mockImplementation(async (instruction?: unknown) =>
          typeof instruction === "string"
            ? []
            : [{ selector: "xpath=//probe-presence", description: "probe-presence" }]
        ),
    } as unknown as Stagehand;

    vi.mocked(createBrowserSession).mockResolvedValue({
      stagehand,
      limiter: {} as never,
      sessionId: "test-session",
      provider: "browserbase",
      close: vi.fn().mockResolvedValue(undefined),
    } as never);

    process.argv = flowArgv();

    await expect(main()).resolves.toBeUndefined();

    // Exactly one session for the whole run — no replan-triggered second
    // `createBrowserSession` call, the consequence the report's "unbounded
    // churn" section describes.
    expect(createBrowserSession).toHaveBeenCalledTimes(1);

    // Both toggle clicks actually fired, each exactly once — proving neither
    // step needed a retry/escalation, so the run never hit the cause-based
    // replan-budget branch (recon-browser.ts:2779-2802).
    expect(clickCount).toBe(2);
    expect(stagehand.act).toHaveBeenCalledTimes(2);

    const allLogged = [
      ...loggerStub.info.mock.calls.map((c) => String(c[0])),
      ...loggerStub.warn.mock.calls.map((c) => String(c[0])),
      ...loggerStub.error.mock.calls.map((c) => String(c[0])),
    ].join("\n");
    expect(allLogged).not.toContain("attempting global replan");
    expect(allLogged).not.toContain("cascade-exhausted");
    expect(allLogged).not.toContain("replan budget exhausted");
    expect(allLogged).not.toContain("terminally failed");
  });
});
