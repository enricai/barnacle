import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page, Stagehand } from "@browserbasehq/stagehand";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.RECON_RUN_ID = "flow-runner-cosmetic-query-reload-submit-shaped-no-judge-test";
process.env.RECON_OUT_DIR = mkdtempSync(
  join(tmpdir(), "recon-cosmetic-query-reload-submit-shaped-no-judge-")
);

import type { AttemptRecord } from "@/scraper/flow-runner";
import { executeStepWithHealing } from "@/scraper/flow-runner";
import { resolveReconRunDir } from "@/scripts/recon-shared";
import type { Logger } from "@/types/logging";

/**
 * Sibling regression to
 * `flow-runner.captcha-gated-submit-navigation-credit-acceptance.test.ts`,
 * isolating the SAME raw `urlChanged` producer (flow-runner.ts's
 * `hasOriginOrPathChanged(pre.url, post.url)`) for a step whose submit-judge
 * re-litigation (the `requireSubmitEndpoint || resolvedElementIsSubmitShaped`
 * gate) never runs: `submitEndpointPattern` is null so `requireSubmitEndpoint`
 * is false, and the resolved click target itself is not attribute-detected as
 * submit-shaped. In that case `verified`/`verifiedBy: "url"` come straight
 * from `urlChanged` with no judge to re-litigate it — exactly the gap the
 * chokepoint rationale (flow-runner.ts ~L12187) calls out as equally broken
 * before the root-cause fix (route `urlChanged` through
 * `hasOriginOrPathChanged` rather than a raw `post.url !== pre.url` string
 * compare) and silently masked by the judge in the submit-endpoint-configured
 * case. A post-click URL differing from the pre-click URL only by a
 * transient query param on the identical origin+path must NOT be credited.
 */

const testLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const PRE_URL = "https://forms.example.com/apply/review";
/** Same origin + path as PRE_URL — only a transient query param differs. */
const POST_URL = "https://forms.example.com/apply/review?reloaded=1";

/** Minimal fake submit-shaped-step DOM + Stagehand `Page`, driven entirely through `page.evaluate`. */
function makeFakePage(): { page: Page; clickCount: { n: number } } {
  const clickCount = { n: 0 };

  const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
    const src = String(expr);
    if (src.includes("outerHTML") && src.includes("innerText")) {
      return { html: 0, text: "0:", values: "", state: "" };
    }
    if (src.includes("isInvalid(el)")) return 0;
    // resolvedClickTargetIsSubmitShaped's attribute-based probe: the
    // resolved element is NOT submit-shaped, so the judge-gate OTHER
    // condition (`resolvedElementIsSubmitShaped`) also never fires — the
    // only path left to `verified` is the raw urlChanged producer.
    if (src.includes("isSubmitShaped")) return false;
    // resolvedClickTargetStillPresent's xpath re-check — element is still there.
    if (src.includes("singleNodeValue !== null")) return true;
    if (src.includes("isDisabled")) return false;
    if (src.includes("el.type")) return null;
    return null;
  });

  const page = {
    evaluate,
    // Cosmetic same-path reload: query string flips once the click fires,
    // origin and pathname never change.
    url: () => (clickCount.n > 0 ? POST_URL : PRE_URL),
    title: vi.fn().mockResolvedValue(""),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        isChecked: vi.fn().mockResolvedValue(false),
        inputValue: vi.fn().mockResolvedValue(""),
      }),
    }),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;

  return { page, clickCount };
}

function baseParams(
  page: Page,
  stagehand: Stagehand,
  trajectory: { stepIndex: number; verifiedBy: AttemptRecord["verifiedBy"]; targetId?: string }[]
): Parameters<typeof executeStepWithHealing>[0] {
  return {
    stagehand,
    page,
    step: "Click the 'Submit Application' button",
    optional: false,
    upload: false,
    // Flow-authored submit flag, but with NO submitEndpointPattern — this is
    // what keeps requireSubmitEndpoint false and the judge block unreachable.
    submitStep: true,
    flowHasSubmitSemantics: true,
    stepIndex: 0,
    phase: "apply",
    signalCounter: { n: 0 },
    recentCaptures: [] as string[],
    recentCaptureMeta: [] as { method: string; status: number; url: string }[],
    anthropic: null,
    rephraseModel: null,
    logger: testLogger,
    captureFn: vi.fn().mockResolvedValue(undefined),
    uploadFixture: null,
    isFinalStep: true,
    submitEndpointPattern: null,
    submittedStateSelectors: [] as string[],
    requireSubmitEndpointMatch: false,
    advanceTransitionBodyPattern: null,
    successUrlFragments: [] as string[],
    successPageTitleHints: [] as string[],
    ownBackendHostnames: [] as string[],
    knownErrorClassPrefixes: [] as string[],
    wizardExitButtonLabels: [] as string[],
    trajectory,
  };
}

describe("flow-runner/executeStepWithHealing — submit-shaped step bypassing the submit-judge must not credit a cosmetic same-path query reload as verifiedBy='url'", () => {
  let capturesDir: string;

  beforeEach(() => {
    capturesDir = resolveReconRunDir().graphqlDir;
    rmSync(capturesDir, { recursive: true, force: true });
    mkdirSync(capturesDir, { recursive: true });
  });

  it("does not resolve 'completed' nor tag the trajectory verifiedBy 'url' on a same-origin/path reload that only adds a query param", async () => {
    const { page, clickCount } = makeFakePage();
    const stagehand = {
      act: vi.fn().mockImplementation(async () => {
        clickCount.n += 1;
        return {
          success: true,
          message: "clicked",
          actionDescription: "Clicked 'Submit Application'",
          actions: [
            {
              selector: "xpath=//button[@data-action='submit']",
              description: "Submit Application",
              method: "click",
            },
          ],
        };
      }),
      // Focused observe stays blind (every step verifies via act()'s own
      // reported action); unfocused observe reports a stub "page has
      // content" candidate so probeStepBeforeAttempts's reachability
      // fallback hands off to the cascade instead of short-circuiting to
      // "absent" before act() ever runs.
      observe: vi
        .fn()
        .mockImplementation(async (instruction?: unknown) =>
          typeof instruction === "string"
            ? []
            : [{ selector: "xpath=//probe-presence", description: "probe-presence" }]
        ),
    } as unknown as Stagehand;
    const trajectory: {
      stepIndex: number;
      verifiedBy: AttemptRecord["verifiedBy"];
      targetId?: string;
    }[] = [];

    await expect(
      executeStepWithHealing(baseParams(page, stagehand, trajectory))
    ).rejects.toMatchObject({ name: "StepVerificationError" });

    expect(clickCount.n).toBeGreaterThan(0);
    expect(trajectory).toEqual([]);
    expect(testLogger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("navigation to a new origin/path confirmed the advance")
    );
  });
});
