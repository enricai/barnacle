import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ActResult, Page, Stagehand } from "@browserbasehq/stagehand";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { executeStepWithHealing } from "@/scraper/flow-runner";
import { mainFrameTarget } from "@/scraper/frame-target";
import type { SubmitCandidate } from "@/scraper/submit-control";
import type { Logger } from "@/types/logging";

describe("recon-browser/dumpStepFailure — target-resolution diagnostic snapshot round-trip", () => {
  const outDir = mkdtempSync(join(tmpdir(), "recon-diag-snapshot-"));
  const ORIGINAL_OUT_DIR = process.env.RECON_OUT_DIR;
  const ORIGINAL_RUN_ID = process.env.RECON_RUN_ID;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env.RECON_OUT_DIR = ORIGINAL_OUT_DIR;
    process.env.RECON_RUN_ID = ORIGINAL_RUN_ID;
    rmSync(outDir, { recursive: true, force: true });
  });

  it("writes the targetResolutionDiagnostic snapshot into the step-failures bundle it persists", async () => {
    process.env.RECON_OUT_DIR = outDir;
    process.env.RECON_RUN_ID = "diag-snapshot-round-trip";

    const { dumpStepFailure } = await import("@/scripts/recon-browser.js");
    const { stepFailuresDir } = (await import("@/scripts/recon-shared.js")).resolveReconRunDir();

    const snapshot = {
      candidates: [
        {
          tag: "div",
          role: "button",
          accessibleName: "Place order",
          tier: 2 as const,
          visible: true,
          disabled: false,
        },
      ],
      accessibilityExcerpt: "region containing the checkout action",
    };

    const target = dumpStepFailure({
      stepIndex: 3,
      phase: "cascade-exhaustion",
      originalStep: "click the place order control",
      attempts: [],
      finalObserve: [],
      pageUrl: "https://example.test/checkout",
      pageTitle: "Checkout",
      recentCaptures: [],
      bodyOuterHtml: "<body></body>",
      unfocusedObserve: [],
      targetResolutionDiagnostic: snapshot,
    });

    expect(target).toBe(join(stepFailuresDir, "003-cascade-exhaustion.json"));
    const written = JSON.parse(readFileSync(target, "utf8"));
    expect(written.targetResolutionDiagnostic).toEqual(snapshot);
  });

  it("round-trips a null snapshot when the capture itself failed", async () => {
    process.env.RECON_OUT_DIR = outDir;
    process.env.RECON_RUN_ID = "diag-snapshot-null";

    const { dumpStepFailure } = await import("@/scripts/recon-browser.js");

    const target = dumpStepFailure({
      stepIndex: 1,
      phase: "probe-absent",
      originalStep: "click the place order control",
      attempts: [],
      finalObserve: [],
      pageUrl: "https://example.test/checkout",
      pageTitle: "Checkout",
      recentCaptures: [],
      bodyOuterHtml: null,
      unfocusedObserve: [],
      targetResolutionDiagnostic: null,
    });

    const written = JSON.parse(readFileSync(target, "utf8"));
    expect(written.targetResolutionDiagnostic).toBeNull();
  });

  it("drives a real cascade-exhaustion failure through executeStepWithHealing and persists the diagnostic it actually captured", async () => {
    process.env.RECON_OUT_DIR = outDir;
    process.env.RECON_RUN_ID = "diag-snapshot-e2e";

    const { dumpStepFailure } = await import("@/scripts/recon-browser.js");
    const { stepFailuresDir } = (await import("@/scripts/recon-shared.js")).resolveReconRunDir();

    const rankedCandidates: SubmitCandidate[] = [
      { deepIndex: 2, tier: 3, tag: "button", accessibleName: "Place order" },
    ];
    const evaluate = vi.fn().mockImplementation(async (expr: unknown) => {
      const src = String(expr);
      if (src.includes("ranked.sort")) return rankedCandidates;
      if (src.includes("const indices = ")) {
        return {
          details: [{ role: "button", visible: true, disabled: false }],
          excerpt: "region containing the checkout action",
        };
      }
      if (src.includes('__mouse("click"')) return { clicked: false };
      if (src.includes("outerHTML")) return { html: 0, text: "0:" };
      if (src.includes("isInvalid(el)")) return 0;
      return null;
    });
    const page = {
      evaluate,
      url: () => "https://example.test/checkout",
      title: vi.fn().mockResolvedValue("Checkout"),
      locator: vi.fn().mockReturnValue({
        first: () => ({
          isChecked: vi.fn().mockResolvedValue(false),
          inputValue: vi.fn().mockResolvedValue(""),
        }),
      }),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      getSessionForFrame: () => ({ on: () => {}, off: () => {} }),
      mainFrameId: () => "main",
      sendCDP: vi.fn().mockResolvedValue({ body: "{}", base64Encoded: false }),
    } as unknown as Page;
    const stagehand = {
      act: vi.fn().mockResolvedValue({ success: false, message: "no-op" } as ActResult),
      observe: vi.fn().mockResolvedValue([]),
    } as unknown as Stagehand;
    const testLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger;

    await expect(
      executeStepWithHealing({
        stagehand,
        page,
        frameTarget: mainFrameTarget(page),
        step: "submit the checkout form",
        optional: false,
        upload: false,
        submitStep: true,
        flowHasSubmitSemantics: true,
        stepIndex: 3,
        phase: "cascade-exhaustion",
        signalCounter: { n: 0 },
        recentCaptures: [],
        recentCaptureMeta: [],
        anthropic: null,
        rephraseModel: null,
        logger: testLogger,
        captureFn: vi.fn().mockResolvedValue(undefined),
        uploadFixture: null,
        isFinalStep: true,
        submitEndpointPattern: null,
        submittedStateSelectors: [],
        requireSubmitEndpointMatch: false,
        advanceTransitionBodyPattern: null,
        successUrlFragments: [],
        successPageTitleHints: [],
        ownBackendHostnames: [],
        knownErrorClassPrefixes: [],
        wizardExitButtonLabels: [],
        onStepFailure: dumpStepFailure,
      })
    ).rejects.toMatchObject({ name: "StepVerificationError" });

    const target = join(stepFailuresDir, "003-cascade-exhaustion.json");
    const written = JSON.parse(readFileSync(target, "utf8"));
    expect(written.targetResolutionDiagnostic).toMatchObject({
      candidates: [
        {
          tag: "button",
          accessibleName: "Place order",
          tier: 3,
          role: "button",
          visible: true,
          disabled: false,
        },
      ],
      accessibilityExcerpt: "region containing the checkout action",
    });
  });
});
