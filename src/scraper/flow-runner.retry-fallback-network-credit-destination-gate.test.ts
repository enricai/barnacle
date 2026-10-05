import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type AttemptRecord, executeStepWithHealing } from "@/scraper/flow-runner";
import { resolveReconRunDir } from "@/scripts/recon-shared";
import type { Logger } from "@/types/logging";

/**
 * The n+16 fallback's raw network signal (`retryNetworkIsRealAdvance`) feeds
 * `shouldVetoFallbackAdvance` and `retryHasSubmitTransitionSignal`; it must be
 * destination-gated like `retryVerified`, so traffic on an implausible
 * sign-in-shaped landing URL for an inferred-final step is not credited.
 */

process.env.RECON_RUN_ID = "n16-network-gate";
process.env.RECON_OUT_DIR = mkdtempSync(join(tmpdir(), "n16-network-gate-"));

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

function makePage(urls: { current: string }, counter: { n: number }, landing: string): Page {
  return {
    evaluate: vi.fn().mockImplementation(async (expr: unknown) => {
      const src = String(expr);
      if (src.includes("XPathResult.FIRST_ORDERED_NODE_TYPE") && src.includes('kind: "click"')) {
        urls.current = landing;
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
        return { fired: true, kind: "click" };
      }
      return null;
    }),
    url: () => urls.current,
    title: vi.fn().mockResolvedValue("App"),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        click: vi.fn().mockResolvedValue(undefined),
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue(""),
      }),
    }),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;
}

async function run(landing: string): Promise<{ attempts: AttemptRecord[]; threw: boolean }> {
  const urls = { current: "https://example.com/checkout/shipping" };
  const counter = { n: 0 };
  const failures: AttemptRecord[][] = [];
  const threw = await executeStepWithHealing({
    stagehand: {} as unknown as Stagehand,
    page: makePage(urls, counter, landing),
    step: STEP,
    optional: false,
    upload: false,
    submitStep: false,
    flowHasSubmitSemantics: true,
    stepIndex: 0,
    totalSteps: () => 1,
    isFinalStep: true,
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
    advanceTransitionBodyPattern: "TransitionWorklet",
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
  return { attempts: failures[0] ?? [], threw };
}

describe("flow-runner n+16 fallback — network credit is destination-gated", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("implausible sign-in landing with network traffic on an inferred-final step is not verified", async () => {
    const { attempts, threw } = await run("https://example.com/login");
    expect(threw).toBe(true);
    for (const a of attempts) {
      expect(a.verifiedBy).not.toBe("url");
      expect(a.verifiedBy).not.toBe("network");
    }
  });
});
