import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type AttemptRecord, executeStepWithHealing } from "@/scraper/flow-runner";
import { resolveReconRunDir } from "@/scripts/recon-shared";
import type { Logger } from "@/types/logging";

/**
 * The n+16 fallback must wait for the re-click's network activity to settle
 * before its verification snapshot, so a request signal landing ~6s after the
 * click is credited rather than judged no-effect.
 */

process.env.RECON_RUN_ID = "n16-slow-settle";
process.env.RECON_OUT_DIR = mkdtempSync(join(tmpdir(), "n16-slow-settle-"));

const guardedObserve = vi.fn();
const guardedAct = vi.fn();

vi.mock("@/scraper/stagehand-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scraper/stagehand-guard")>();
  return {
    ...actual,
    guardedObserve: (...args: unknown[]) => guardedObserve(...args),
    guardedAct: (...args: unknown[]) => guardedAct(...args),
  };
});

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const STEP = "confirm the shipping address and continue";
const XPATH = "xpath=/html[1]/body[1]/div[1]/button[1]";

const PAGE_BEFORE = "996:Skip to main content|Shipping|Review your address|Continue";
const PAGE_AFTER = "588:Skip to main content|Delivery options|Choose a speed";

let lateSignalMs = 6000;

function makePage(
  urls: { current: string },
  counter: { n: number },
  clock: {
    now: number;
    clickAt: number | null;
    fallbackClicks: number;
    escalatedClicks: number;
    deepRankProbes: number;
  },
  advance: { enabled: boolean; landUrl?: string } = { enabled: false }
): Page {
  return {
    evaluate: vi.fn().mockImplementation(async (expr: unknown) => {
      const src = String(expr);
      if (advance.enabled && src.includes("outerHTML") && src.includes("values")) {
        return clock.fallbackClicks > 0
          ? { html: 29300, text: PAGE_AFTER, values: "", state: "0:0" }
          : { html: 31284, text: PAGE_BEFORE, values: "", state: "0:0" };
      }
      if (src.includes("ranked.sort")) clock.deepRankProbes += 1;
      if (src.includes("XPathResult.FIRST_ORDERED_NODE_TYPE") && src.includes('kind: "click"')) {
        clock.clickAt = clock.now;
        clock.fallbackClicks += 1;
        if (advance.landUrl) urls.current = advance.landUrl;
        return { fired: true, kind: "click" };
      }
      return null;
    }),
    url: () => urls.current,
    title: vi.fn().mockResolvedValue("App"),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        click: vi.fn().mockImplementation(async () => {
          clock.escalatedClicks += 1;
        }),
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue(""),
      }),
    }),
    waitForTimeout: vi.fn().mockImplementation(async (ms: number) => {
      clock.now += ms;
      if (clock.clickAt !== null && clock.now - clock.clickAt >= lateSignalMs) {
        clock.clickAt = null;
        counter.n += 1;
        const dir = resolveReconRunDir().graphqlDir;
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, "5-transition.json"),
          JSON.stringify({
            requestPostData: "TransitionWorklet",
            variables: { input: { type: "next" } },
          })
        );
      }
    }),
  } as unknown as Page;
}

interface RunOptions {
  midFlowAdvance?: boolean;
  isFinalStep?: boolean;
  startUrl?: string;
  landUrl?: string;
}

async function run(options: RunOptions = {}): Promise<{
  attempts: AttemptRecord[];
  threw: boolean;
  clock: { fallbackClicks: number; escalatedClicks: number; deepRankProbes: number };
}> {
  const midFlowAdvance = options.midFlowAdvance === true;
  const urls = { current: options.startUrl ?? "https://example.com/checkout/shipping" };
  const counter = { n: 0 };
  const clock = {
    now: 0,
    clickAt: null as number | null,
    fallbackClicks: 0,
    escalatedClicks: 0,
    deepRankProbes: 0,
  };
  const failures: AttemptRecord[][] = [];
  const threw = await executeStepWithHealing({
    stagehand: {} as unknown as Stagehand,
    page: makePage(urls, counter, clock, { enabled: midFlowAdvance, landUrl: options.landUrl }),
    step: STEP,
    optional: false,
    upload: false,
    submitStep: midFlowAdvance,
    flowHasSubmitSemantics: true,
    stepIndex: 0,
    totalSteps: () => (options.isFinalStep === false ? 2 : 1),
    isFinalStep: options.isFinalStep ?? true,
    phase: "flow",
    signalCounter: counter,
    recentCaptures: [],
    recentCaptureMeta: [],
    anthropic: null,
    rephraseModel: null,
    logger: testLogger,
    uploadFixture: null,
    submitEndpointPattern: null,
    submittedStateSelectors: [],
    requireSubmitEndpointMatch: false,
    advanceTransitionBodyPattern: midFlowAdvance ? null : "TransitionWorklet",
    successUrlFragments: [],
    successPageTitleHints: [],
    ownBackendHostnames: [],
    knownErrorClassPrefixes: [],
    wizardExitButtonLabels: [],
    onStepFailure: ({ attempts }: { attempts: AttemptRecord[] }) => {
      failures.push(attempts);
      return null;
    },
  } as never).then(
    () => false,
    () => true
  );
  return { attempts: failures[0] ?? [], threw, clock };
}

describe("flow-runner n+16 fallback — slow click settles before the retry snapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lateSignalMs = 6000;
    guardedAct.mockResolvedValue({
      success: true,
      message: "clicked",
      actionDescription: "Continue",
      actions: [{ selector: XPATH, description: "Continue", method: "click" }],
    });
    guardedObserve.mockImplementation(async (_s: unknown, instruction?: unknown) =>
      typeof instruction === "string"
        ? [{ selector: XPATH, description: "Continue", method: "click" }]
        : []
    );
  });

  it("credits a fallback click whose network signal lands ~6s late", async () => {
    const { attempts, threw, clock } = await run();
    expect(threw).toBe(false);
    expect(attempts).toEqual([]);
    expect(clock.fallbackClicks).toBe(1);
    expect(clock.escalatedClicks).toBe(1);
    expect(clock.deepRankProbes).toBe(0);
  });

  it("control: with no signal ever arriving the fallback is not credited", async () => {
    lateSignalMs = Number.POSITIVE_INFINITY;
    const { threw } = await run();
    expect(threw).toBe(true);
  });

  it("credits a mid-flow submit whose page advanced with no network, with a single click", async () => {
    lateSignalMs = Number.POSITIVE_INFINITY;
    const { attempts, threw, clock } = await run({ midFlowAdvance: true, isFinalStep: false });
    expect(threw).toBe(false);
    expect(attempts).toEqual([]);
    expect(clock.fallbackClicks).toBe(1);
    expect(clock.escalatedClicks).toBe(1);
    expect(clock.deepRankProbes).toBe(0);
    const logs = vi
      .mocked(testLogger.info)
      .mock.calls.concat(vi.mocked(testLogger.warn).mock.calls)
      .map((c) => String(c[0]));
    expect(logs.some((l) => l.includes("phantom-click-exhausted"))).toBe(false);
  });

  it("control: the same DOM change on the final step is not credited via DOM alone", async () => {
    lateSignalMs = Number.POSITIVE_INFINITY;
    const { threw } = await run({ midFlowAdvance: true, isFinalStep: true });
    expect(threw).toBe(true);
  });

  it("credits a mid-flow submit whose URL stays sign-in-shaped (text swaps, no network)", async () => {
    lateSignalMs = Number.POSITIVE_INFINITY;
    const { attempts, threw, clock } = await run({
      midFlowAdvance: true,
      isFinalStep: false,
      startUrl: "https://shop.example.com/login",
    });
    expect(threw).toBe(false);
    expect(attempts).toEqual([]);
    expect(clock.fallbackClicks).toBe(1);
    const logs = vi
      .mocked(testLogger.info)
      .mock.calls.concat(vi.mocked(testLogger.warn).mock.calls)
      .map((c) => String(c[0]));
    expect(logs.some((l) => l.includes("phantom-click-exhausted"))).toBe(false);
  });

  it("control: a final step on a sign-in-shaped URL is still not credited", async () => {
    lateSignalMs = Number.POSITIVE_INFINITY;
    const { threw } = await run({
      midFlowAdvance: true,
      isFinalStep: true,
      startUrl: "https://shop.example.com/login",
    });
    expect(threw).toBe(true);
  });

  it("control: a bounce from a non-auth URL to a sign-in gate is still vetoed", async () => {
    lateSignalMs = Number.POSITIVE_INFINITY;
    const { threw } = await run({
      midFlowAdvance: true,
      isFinalStep: false,
      landUrl: "https://shop.example.com/login",
    });
    expect(threw).toBe(true);
  });
});
