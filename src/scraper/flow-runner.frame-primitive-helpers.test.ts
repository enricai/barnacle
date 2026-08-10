import { describe, expect, it, vi } from "vitest";

import {
  countNgInvalidContainers,
  fillHtml5DateTimeInput,
  pollEnumerate,
  probeLeafInvalidContainers,
  snapshotPage,
  verifyFillReadback,
} from "@/scraper/flow-runner";
import { type FrameTarget, mainFrameTarget } from "@/scraper/frame-target";

/**
 * Minimal fake `FrameTarget`: each test scripts `evaluate` to return whatever
 * a real child-frame `evaluate` would answer for the expression the helper
 * under test builds, and `url`/`title` are fixed strings so assertions on
 * `snapshotPage`'s returned `url` field don't depend on a real Page.
 */
function makeFakeTarget(
  evaluateImpl: (expr: unknown) => Promise<unknown>,
  overrides: Partial<FrameTarget> = {}
): FrameTarget {
  return {
    frame: {} as FrameTarget["frame"],
    frameSelector: "iframe#apply_frame",
    evaluate: evaluateImpl as FrameTarget["evaluate"],
    locator: (selector: string) => ({ scope: "frame" as const, selector }) as never,
    url: () => Promise.resolve("https://apply.example.com/application/abc-123"),
    title: () => Promise.resolve("main document title"),
    ...overrides,
  };
}

/** Minimal fake `Page` for `mainFrameTarget(page)` — proves main-frame delegation. */
function makeFakePage(evaluateImpl: (expr: unknown) => Promise<unknown>) {
  return {
    evaluate: vi.fn().mockImplementation(evaluateImpl),
    locator: vi.fn().mockImplementation((selector: string) => ({ scope: "main", selector })),
    url: () => "https://careers.example.org/jobs/123",
    title: async () => "main document title",
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  };
}

describe("flow-runner/snapshotPage", () => {
  it("evaluates via the resolved child frame, not page.evaluate", async () => {
    const targetEvaluate = vi.fn().mockResolvedValue({ html: 42, text: "5:hello" });
    const target = makeFakeTarget(targetEvaluate);

    const snapshot = await snapshotPage(target, { n: 3 });

    expect(targetEvaluate).toHaveBeenCalledTimes(1);
    expect(snapshot).toEqual({
      networkCount: 3,
      url: "https://apply.example.com/application/abc-123",
      bodyHtmlLength: 42,
      visibleTextSignature: "5:hello",
      formValueSignature: "",
    });
  });

  it("behaves byte-identically for a main-frame target: delegates to page.evaluate", async () => {
    const page = makeFakePage(async () => ({ html: 10, text: "3:abc" }));

    const snapshot = await snapshotPage(mainFrameTarget(page as never), { n: 1 });

    expect(page.evaluate).toHaveBeenCalledTimes(1);
    expect(snapshot).toEqual({
      networkCount: 1,
      url: "https://careers.example.org/jobs/123",
      bodyHtmlLength: 10,
      visibleTextSignature: "3:abc",
      formValueSignature: "",
    });
  });

  it("defaults to 0/empty-string on evaluate failure, regardless of frame", async () => {
    const target = makeFakeTarget(vi.fn().mockRejectedValue(new Error("detached")));

    const snapshot = await snapshotPage(target, { n: 0 });

    expect(snapshot.bodyHtmlLength).toBe(0);
    expect(snapshot.visibleTextSignature).toBe("");
  });

  it("defaults to 0/empty-string when the evaluate result doesn't match the expected shape", async () => {
    const target = makeFakeTarget(vi.fn().mockResolvedValue({ unexpected: true }));

    const snapshot = await snapshotPage(target, { n: 0 });

    expect(snapshot.bodyHtmlLength).toBe(0);
    expect(snapshot.visibleTextSignature).toBe("");
  });
});

describe("flow-runner/countNgInvalidContainers", () => {
  it("evaluates via the resolved child frame, not page.evaluate", async () => {
    const targetEvaluate = vi.fn().mockResolvedValue(2);
    const target = makeFakeTarget(targetEvaluate);

    const count = await countNgInvalidContainers(target);

    expect(count).toBe(2);
    expect(targetEvaluate).toHaveBeenCalledTimes(1);
  });

  it("behaves byte-identically for a main-frame target: delegates to page.evaluate", async () => {
    const page = makeFakePage(async () => 5);

    const count = await countNgInvalidContainers(mainFrameTarget(page as never));

    expect(count).toBe(5);
    expect(page.evaluate).toHaveBeenCalledTimes(1);
  });

  it("returns 0 on evaluate failure", async () => {
    const target = makeFakeTarget(vi.fn().mockRejectedValue(new Error("detached")));

    expect(await countNgInvalidContainers(target)).toBe(0);
  });

  it("returns 0 when evaluate resolves a non-number", async () => {
    const target = makeFakeTarget(vi.fn().mockResolvedValue("not-a-number"));

    expect(await countNgInvalidContainers(target)).toBe(0);
  });
});

describe("flow-runner/probeLeafInvalidContainers", () => {
  const sampleField = {
    xpath: "/html[1]/body[1]/div[2]/input[1]",
    label: "First Name",
    framework: "angular" as const,
    markerClass: "ng-invalid ng-touched",
    visibleErrorText: "This field is required",
    inputTag: "input",
  };

  it("evaluates via the resolved child frame, not page.evaluate", async () => {
    const targetEvaluate = vi.fn().mockResolvedValue([sampleField]);
    const target = makeFakeTarget(targetEvaluate);

    const fields = await probeLeafInvalidContainers(target);

    expect(fields).toEqual([sampleField]);
    expect(targetEvaluate).toHaveBeenCalledTimes(1);
  });

  it("behaves byte-identically for a main-frame target: delegates to page.evaluate", async () => {
    const page = makeFakePage(async () => [sampleField]);

    const fields = await probeLeafInvalidContainers(mainFrameTarget(page as never));

    expect(fields).toEqual([sampleField]);
    expect(page.evaluate).toHaveBeenCalledTimes(1);
  });

  it("returns an empty array on evaluate failure (safe fallback to the Haiku judge)", async () => {
    const target = makeFakeTarget(vi.fn().mockRejectedValue(new Error("CSP violation")));

    expect(await probeLeafInvalidContainers(target)).toEqual([]);
  });

  it("returns an empty array when evaluate resolves a non-array", async () => {
    const target = makeFakeTarget(vi.fn().mockResolvedValue(null));

    expect(await probeLeafInvalidContainers(target)).toEqual([]);
  });
});

describe("flow-runner/fillHtml5DateTimeInput", () => {
  it("evaluates via the resolved child frame, not page.evaluate", async () => {
    const targetEvaluate = vi
      .fn()
      .mockResolvedValue({ filled: true, postValue: "2026-06-14", inputType: "date" });
    const target = makeFakeTarget(targetEvaluate);

    const result = await fillHtml5DateTimeInput(target, "/html/body/input[1]", "2026-06-14");

    expect(result).toEqual({ filled: true, postValue: "2026-06-14", inputType: "date" });
    expect(targetEvaluate).toHaveBeenCalledTimes(1);
  });

  it("behaves byte-identically for a main-frame target: delegates to page.evaluate", async () => {
    const page = makeFakePage(async () => ({
      filled: true,
      postValue: "2026-06-14",
      inputType: "date",
    }));

    const result = await fillHtml5DateTimeInput(
      mainFrameTarget(page as never),
      "/html/body/input[1]",
      "06-14-2026"
    );

    expect(result).toEqual({ filled: true, postValue: "2026-06-14", inputType: "date" });
    expect(page.evaluate).toHaveBeenCalledTimes(1);
  });

  it("returns null when the resolved element isn't a recognized date/time input type", async () => {
    const target = makeFakeTarget(
      vi.fn().mockResolvedValue({ filled: false, postValue: "abc", inputType: "text" })
    );

    expect(await fillHtml5DateTimeInput(target, "/html/body/input[1]", "abc")).toBeNull();
  });

  it("returns null on evaluate failure", async () => {
    const target = makeFakeTarget(vi.fn().mockRejectedValue(new Error("detached")));

    expect(await fillHtml5DateTimeInput(target, "/html/body/input[1]", "2026-06-14")).toBeNull();
  });

  it("returns null when the xpath doesn't resolve to an element", async () => {
    const target = makeFakeTarget(vi.fn().mockResolvedValue(null));

    expect(await fillHtml5DateTimeInput(target, "/html/body/input[99]", "2026-06-14")).toBeNull();
  });
});

describe("flow-runner/verifyFillReadback", () => {
  it("evaluates via the resolved child frame, not page.evaluate", async () => {
    const targetEvaluate = vi
      .fn()
      .mockResolvedValue({ outcome: "matched", postValue: "Jane", tag: "input" });
    const target = makeFakeTarget(targetEvaluate);

    const result = await verifyFillReadback(target, "/html/body/input[1]", "Jane");

    expect(result).toEqual({ outcome: "matched", postValue: "Jane", tag: "input" });
    expect(targetEvaluate).toHaveBeenCalledTimes(1);
  });

  it("behaves byte-identically for a main-frame target: delegates to page.evaluate", async () => {
    const page = makeFakePage(async () => ({ outcome: "rejected", postValue: "", tag: "input" }));

    const result = await verifyFillReadback(
      mainFrameTarget(page as never),
      "/html/body/input[1]",
      "06-14-2026"
    );

    expect(result).toEqual({ outcome: "rejected", postValue: "", tag: "input" });
    expect(page.evaluate).toHaveBeenCalledTimes(1);
  });

  it("reports 'differs' when the readback value is non-empty but not an exact match (masked input)", async () => {
    const target = makeFakeTarget(
      vi.fn().mockResolvedValue({ outcome: "differs", postValue: "(555) 123-4567", tag: "input" })
    );

    const result = await verifyFillReadback(target, "/html/body/input[1]", "5551234567");

    expect(result).toEqual({ outcome: "differs", postValue: "(555) 123-4567", tag: "input" });
  });

  it("returns null for a non-fillable element (caller skips the check)", async () => {
    const target = makeFakeTarget(vi.fn().mockResolvedValue(null));

    expect(await verifyFillReadback(target, "/html/body/div[1]", "Jane")).toBeNull();
  });

  it("returns null on evaluate failure", async () => {
    const target = makeFakeTarget(vi.fn().mockRejectedValue(new Error("detached")));

    expect(await verifyFillReadback(target, "/html/body/input[1]", "Jane")).toBeNull();
  });
});

describe("flow-runner/pollEnumerate (file-upload locator path)", () => {
  const fileInputExpr = "document.querySelectorAll('input[type=file]').length";

  it("evaluates via the resolved child frame, not page.evaluate — proves the upload widget's presence probe is frame-scoped", async () => {
    const page = { waitForTimeout: vi.fn().mockResolvedValue(undefined) };
    const targetEvaluate = vi.fn().mockResolvedValue(1);
    const target = makeFakeTarget(targetEvaluate);

    const count = await pollEnumerate<number>(
      page as never,
      target,
      fileInputExpr,
      (n) => (n ?? 0) > 0
    );

    expect(count).toBe(1);
    expect(targetEvaluate).toHaveBeenCalledTimes(1);
    expect(targetEvaluate).toHaveBeenCalledWith(fileInputExpr);
    expect(page.waitForTimeout).not.toHaveBeenCalled();
  });

  it("behaves byte-identically for a main-frame target: delegates to page.evaluate", async () => {
    const page = makeFakePage(async () => 1);

    const count = await pollEnumerate<number>(
      page as never,
      mainFrameTarget(page as never),
      fileInputExpr,
      (n) => (n ?? 0) > 0
    );

    expect(count).toBe(1);
    expect(page.evaluate).toHaveBeenCalledTimes(1);
    expect(page.evaluate).toHaveBeenCalledWith(fileInputExpr, undefined);
  });

  it("re-polls the child frame on its own evaluate until the input mounts, using page.waitForTimeout between attempts", async () => {
    const page = { waitForTimeout: vi.fn().mockResolvedValue(undefined) };
    const targetEvaluate = vi
      .fn()
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1);
    const target = makeFakeTarget(targetEvaluate);

    const count = await pollEnumerate<number>(
      page as never,
      target,
      fileInputExpr,
      (n) => (n ?? 0) > 0,
      { attempts: 5, intervalMs: 10 }
    );

    expect(count).toBe(1);
    expect(targetEvaluate).toHaveBeenCalledTimes(3);
    expect(page.waitForTimeout).toHaveBeenCalledTimes(2);
    expect(page.waitForTimeout).toHaveBeenCalledWith(10);
  });

  it("returns the last (absent) result once attempts are exhausted, so the caller falls through to click-to-surface", async () => {
    const page = { waitForTimeout: vi.fn().mockResolvedValue(undefined) };
    const targetEvaluate = vi.fn().mockResolvedValue(0);
    const target = makeFakeTarget(targetEvaluate);

    const count = await pollEnumerate<number>(
      page as never,
      target,
      fileInputExpr,
      (n) => (n ?? 0) > 0,
      { attempts: 3, intervalMs: 5 }
    );

    expect(count).toBe(0);
    expect(targetEvaluate).toHaveBeenCalledTimes(3);
  });
});
