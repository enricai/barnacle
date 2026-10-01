import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
      fieldValuesAtFailure: null,
      targetResolutionDiagnostic: snapshot,
    });

    expect(target).toBe(join(stepFailuresDir, "003-cascade-exhaustion.json"));
    const written = JSON.parse(readFileSync(target, "utf8"));
    expect(written.targetResolutionDiagnostic).toEqual(snapshot);
    expect(written.bodyOuterHtml).toBe("<body></body>");
    expect(written.attempts).toEqual([]);
    expect(written.pageUrl).toBe("https://example.test/checkout");
    expect(written.pageTitle).toBe("Checkout");
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
      fieldValuesAtFailure: null,
      targetResolutionDiagnostic: null,
    });

    const written = JSON.parse(readFileSync(target, "utf8"));
    expect(written.targetResolutionDiagnostic).toBeNull();
  });
});
