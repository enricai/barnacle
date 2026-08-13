import { describe, expect, it, vi } from "vitest";

import {
  countNgInvalidContainers,
  fillHtml5DateTimeInput,
  fillTextDatepickerInput,
  parseFillValueIntent,
  pollEnumerate,
  probeLeafInvalidContainers,
  shouldReadbackFillOnActSuccess,
  shouldWarnMissingAdvancePattern,
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
      selectionStateSignature: "",
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
      selectionStateSignature: "",
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

  it("strips Stagehand's xpath= prefix before composing the probe (the #153 datepicker-guard selector)", async () => {
    const targetEvaluate = vi
      .fn()
      .mockResolvedValue({ outcome: "rejected", postValue: "", tag: "input" });
    const target = makeFakeTarget(targetEvaluate);

    const result = await verifyFillReadback(
      target,
      "xpath=/html[1]/body[1]/main[1]/form[1]/input[1]",
      "01/2020"
    );

    expect(result).toEqual({ outcome: "rejected", postValue: "", tag: "input" });
    const expr = targetEvaluate.mock.calls[0]?.[0] as string;
    expect(expr).toContain('"/html[1]/body[1]/main[1]/form[1]/input[1]"');
    expect(expr).not.toContain("xpath=");
  });

  it("returns null without evaluating for a non-xpath selector form (deeplocator / deep-index)", async () => {
    const targetEvaluate = vi.fn().mockResolvedValue(null);
    const target = makeFakeTarget(targetEvaluate);

    expect(await verifyFillReadback(target, "deeplocator=button >> nth=0", "01/2020")).toBeNull();
    expect(await verifyFillReadback(target, "deep-index:7", "01/2020")).toBeNull();
    expect(targetEvaluate).not.toHaveBeenCalled();
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

/**
 * Fake locator recording fill/type/click calls. `fillTextDatepickerInput`
 * calls `target.locator(selector).first()` then those methods.
 */
function makeFakeLocator(): {
  first: () => typeof api;
  calls: string[];
} & Record<string, unknown> {
  const calls: string[] = [];
  const api = {
    first: () => api,
    fill: vi.fn(async (v: string) => {
      calls.push(`fill:${v}`);
    }),
    type: vi.fn(async (v: string) => {
      calls.push(`type:${v}`);
    }),
    click: vi.fn(async () => {
      calls.push("click");
    }),
    calls,
  };
  return api as never;
}

/**
 * Script a datepicker `FrameTarget`: `evaluate` branches on the expression the
 * primitive builds (gate → Enter-dispatch → calendar-pick → readback). `gate`
 * decides whether the input is treated as a datepicker; `readbackSequence`
 * feeds successive `verifyFillReadback` results (keyboard attempt, then pick
 * attempt); `pickResult` is what the open-and-pick evaluate returns.
 */
function makeDatepickerTarget(opts: {
  gateMatch: boolean;
  pickResult?: unknown;
  readbackSequence: (unknown | null)[];
}): FrameTarget & { locator: () => ReturnType<typeof makeFakeLocator> } {
  const readbacks = [...opts.readbackSequence];
  const locator = makeFakeLocator();
  const evaluate = vi.fn(async (expr: unknown) => {
    const s = String(expr);
    if (s.includes("react-datepicker__input-container")) return { match: opts.gateMatch };
    if (s.includes('new KeyboardEvent("keydown"')) return "dispatched";
    if (s.includes("react-datepicker__month-text") && s.includes("querySelectorAll")) {
      return opts.pickResult ?? { picked: false, reason: "no-calendar" };
    }
    if (s.includes("el.isContentEditable")) {
      return readbacks.length > 0 ? readbacks.shift() : null;
    }
    // dispatchJqueryChangeEvent
    if (s.includes("new Event('change'")) return "dispatched";
    return null;
  });
  const target = makeFakeTarget(evaluate, {
    locator: (() => locator) as never,
  }) as FrameTarget & { locator: () => ReturnType<typeof makeFakeLocator> };
  return target;
}

describe("flow-runner/fillTextDatepickerInput", () => {
  it("returns null when the value isn't a parseable date", async () => {
    const target = makeDatepickerTarget({ gateMatch: true, readbackSequence: [] });
    expect(await fillTextDatepickerInput(target, "xpath=//input[1]", "not-a-date")).toBeNull();
  });

  it("returns null when the selector has no xpath= prefix", async () => {
    const target = makeDatepickerTarget({ gateMatch: true, readbackSequence: [] });
    expect(await fillTextDatepickerInput(target, "#css-selector", "2020-01")).toBeNull();
  });

  it("returns null when the gate rejects a non-datepicker text input", async () => {
    const target = makeDatepickerTarget({ gateMatch: false, readbackSequence: [] });
    expect(await fillTextDatepickerInput(target, "xpath=//input[1]", "2020-01")).toBeNull();
  });

  it("commits via keyboard when the widget accepts typed input", async () => {
    const target = makeDatepickerTarget({
      gateMatch: true,
      readbackSequence: [{ outcome: "differs", postValue: "2020-01", tag: "input" }],
    });
    const result = await fillTextDatepickerInput(target, "xpath=//input[1]", "2020-01");
    expect(result).toEqual({ filled: true, postValue: "2020-01", strategy: "keyboard" });
  });

  it("falls through to calendar-pick (month/year variant) when keyboard is rejected", async () => {
    const target = makeDatepickerTarget({
      gateMatch: true,
      pickResult: { picked: true, variant: "month-year" },
      readbackSequence: [
        { outcome: "rejected", postValue: "", tag: "input" }, // keyboard didn't take
        { outcome: "differs", postValue: "2020-01", tag: "input" }, // pick committed
      ],
    });
    const result = await fillTextDatepickerInput(target, "xpath=//input[1]", "2020-01");
    expect(result).toEqual({ filled: true, postValue: "2020-01", strategy: "calendar-pick" });
  });

  it("returns filled:false/strategy:none when neither keyboard nor pick commits", async () => {
    const target = makeDatepickerTarget({
      gateMatch: true,
      pickResult: { picked: false, reason: "no-month-cell" },
      readbackSequence: [
        { outcome: "rejected", postValue: "", tag: "input" },
        { outcome: "rejected", postValue: "", tag: "input" },
      ],
    });
    const result = await fillTextDatepickerInput(target, "xpath=//input[1]", "2020-01");
    expect(result).toEqual({ filled: false, postValue: "", strategy: "none" });
  });

  it("parses ISO, US-slash, and full-date formats to the same month/year", async () => {
    for (const value of ["2020-01", "01/2020", "2020-01-05"]) {
      const target = makeDatepickerTarget({
        gateMatch: true,
        readbackSequence: [{ outcome: "differs", postValue: "2020-01", tag: "input" }],
      });
      const result = await fillTextDatepickerInput(target, "xpath=//input[1]", value);
      expect(result?.filled).toBe(true);
    }
  });
});

describe("flow-runner/shouldWarnMissingAdvancePattern", () => {
  it("warns when advance steps exist and no pattern is set", () => {
    expect(
      shouldWarnMissingAdvancePattern(["Click the Next button to continue", "Fill in name"], null)
    ).toBe(true);
  });

  it("does not warn when the pattern is set", () => {
    expect(
      shouldWarnMissingAdvancePattern(["Click the Next button to continue"], "/applySubmit")
    ).toBe(false);
  });

  it("does not warn when there are no advance steps", () => {
    expect(shouldWarnMissingAdvancePattern(["Fill in name", "Fill in email"], null)).toBe(false);
  });
});

describe("flow-runner/shouldReadbackFillOnActSuccess", () => {
  it("routes a fill-intent act-success step with no strong signal into the read-back", () => {
    expect(
      shouldReadbackFillOnActSuccess({
        actReportedSuccess: true,
        isFillIntent: true,
        hasStrongSignal: false,
      })
    ).toBe(true);
  });

  it("does not read back when a strong signal (network/url/dom) already verified the fill", () => {
    expect(
      shouldReadbackFillOnActSuccess({
        actReportedSuccess: true,
        isFillIntent: true,
        hasStrongSignal: true,
      })
    ).toBe(false);
  });

  it("does not read back a click-intent step (only fills route through the datepicker guard)", () => {
    expect(
      shouldReadbackFillOnActSuccess({
        actReportedSuccess: true,
        isFillIntent: false,
        hasStrongSignal: false,
      })
    ).toBe(false);
  });

  it("does not read back when the act itself reported failure", () => {
    expect(
      shouldReadbackFillOnActSuccess({
        actReportedSuccess: false,
        isFillIntent: true,
        hasStrongSignal: false,
      })
    ).toBe(false);
  });
});

describe("flow-runner/parseFillValueIntent", () => {
  it("recognizes the reported react-datepicker step prose that parseFillStep's strict shape misses", () => {
    // "field" is separated from "with" by "for work experience", so the strict
    // parseFillStep regex returns null — this looser value parser must still fire.
    expect(
      parseFillValueIntent("Fill in the Start Date field for work experience with '01/2020'")
    ).toEqual({ value: "01/2020" });
    expect(
      parseFillValueIntent(
        "Fill in the End Date field for the work experience entry with '01/2021'"
      )
    ).toEqual({ value: "01/2021" });
  });

  it("still recognizes the canonical field-with-value phrasing", () => {
    expect(parseFillValueIntent("Fill in the First Name field with 'Reginald'")).toEqual({
      value: "Reginald",
    });
  });

  it("returns null for a click step (no fill intent)", () => {
    expect(parseFillValueIntent("Click the Continue button")).toBeNull();
  });

  it("returns null for a select step even when a quoted value trails it", () => {
    expect(parseFillValueIntent("Select 'Connecticut' in the State dropdown")).toBeNull();
  });

  it("returns null for a fill step with no quoted value", () => {
    expect(parseFillValueIntent("Fill it with the test candidate's city")).toBeNull();
  });

  it("recognizes the replanner's escalated 'type <value> into ...' reword", () => {
    // The replanner rewords a stuck date fill with no "fill" verb — without the
    // type shape the act-success datepicker guard could never fire on it.
    expect(
      parseFillValueIntent(
        "Type '01/2020' into the Start Date input field for the work experience entry"
      )
    ).toEqual({ value: "01/2020" });
  });

  it("returns null for a type step with no quoted value", () => {
    expect(parseFillValueIntent("Type the start date into the input")).toBeNull();
  });
});
