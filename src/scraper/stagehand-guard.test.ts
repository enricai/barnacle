/**
 * Unit coverage for the Stagehand-call guarded wrappers. Exercises:
 *  - Happy path passthrough on `act` / `observe` / `extract`
 *  - Envelope-validation failure throws `StagehandSchemaError` and records
 *    `failureKind: "schema-validation-failed"` in telemetry
 *  - Underlying Stagehand exceptions propagate AND log
 *    `failureKind: classifyLlmCallFailure(err)`
 *  - Type inference on `guardedExtract` narrows to `z.infer<T>`
 *
 * Strategy: inject a mock `Stagehand` instance and a stub `captureLlmCall`
 * via vitest's module mocking so we don't touch the real NDJSON sink or
 * spin up a browser.
 */

import type { Action, ActResult, Stagehand } from "@browserbasehq/stagehand";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

import type { LlmCallInput } from "@/lib/telemetry/call-capture";
import type { FrameTarget } from "@/scraper/frame-target";

const captured: LlmCallInput[] = [];
vi.mock("@/lib/telemetry/call-capture", async () => {
  const actual = await vi.importActual<typeof import("@/lib/telemetry/call-capture")>(
    "@/lib/telemetry/call-capture"
  );
  return {
    ...actual,
    captureLlmCall: async (input: LlmCallInput): Promise<void> => {
      captured.push(input);
    },
  };
});

import {
  guardedAct,
  guardedExtract,
  guardedObserve,
  StagehandSchemaError,
} from "./stagehand-guard";

beforeEach(() => {
  captured.length = 0;
});

function fakeStagehandAct(result: unknown): Stagehand {
  return { act: vi.fn().mockResolvedValue(result) } as unknown as Stagehand;
}

function fakeStagehandObserve(result: unknown): Stagehand {
  return { observe: vi.fn().mockResolvedValue(result) } as unknown as Stagehand;
}

function fakeStagehandExtract(result: unknown): Stagehand {
  return { extract: vi.fn().mockResolvedValue(result) } as unknown as Stagehand;
}

/** Fake Stagehand whose `act` never settles — simulates a wedged CDP call. */
function fakeStagehandActHung(): Stagehand {
  return { act: vi.fn(() => new Promise<never>(() => {})) } as unknown as Stagehand;
}

/** Fake Stagehand whose `observe` never settles — simulates a wedged CDP call. */
function fakeStagehandObserveHung(): Stagehand {
  return { observe: vi.fn(() => new Promise<never>(() => {})) } as unknown as Stagehand;
}

/** Fake Stagehand whose `extract` never settles — simulates a wedged CDP call. */
function fakeStagehandExtractHung(): Stagehand {
  return { extract: vi.fn(() => new Promise<never>(() => {})) } as unknown as Stagehand;
}

/**
 * Fake Stagehand whose `observe` returns `frameResult` when called with a
 * `selector` option and `topResult` otherwise — matches how the real SDK's
 * candidate search narrows to the scoped frame's DOM, so tests can assert
 * the frame-scoped RETURN VALUE, not just the forwarded call args.
 */
function fakeStagehandObserveByScope(topResult: unknown, frameResult: unknown): Stagehand {
  return {
    observe: vi.fn((..._args: unknown[]) => {
      const options = _args.find((arg) => typeof arg === "object" && arg !== null) as
        | { selector?: string }
        | undefined;
      return Promise.resolve(options?.selector ? frameResult : topResult);
    }),
  } as unknown as Stagehand;
}

/**
 * Fake Stagehand whose `extract` returns `frameResult` when called with a
 * `selector` option and `topResult` otherwise, matching
 * `fakeStagehandObserveByScope` for the extract overload's 3rd-arg options.
 */
function fakeStagehandExtractByScope(topResult: unknown, frameResult: unknown): Stagehand {
  return {
    extract: vi.fn((..._args: unknown[]) => {
      const options = _args[2] as { selector?: string } | undefined;
      return Promise.resolve(options?.selector ? frameResult : topResult);
    }),
  } as unknown as Stagehand;
}

/** Minimal fake `FrameTarget` bound to a resolved cross-origin child frame. */
function fakeChildFrameTarget(frameSelector: string): FrameTarget {
  return {
    frame: {} as never,
    frameSelector,
    evaluate: vi.fn(),
    locator: vi.fn(),
    url: vi.fn(),
    title: vi.fn(),
  };
}

/** Minimal fake `FrameTarget` bound to the main frame (`frameSelector: null`). */
function fakeMainFrameTarget(): FrameTarget {
  return {
    frame: null,
    frameSelector: null,
    evaluate: vi.fn(),
    locator: vi.fn(),
    url: vi.fn(),
    title: vi.fn(),
  };
}

const VALID_ACT_RESULT: ActResult = {
  success: true,
  message: "clicked",
  actionDescription: "Click the submit button",
  actions: [
    {
      selector: "xpath=//button[@type='submit']",
      description: "Submit button",
      method: "click",
    },
  ],
};

const VALID_ACTION: Action = {
  selector: "xpath=//a[@href='/login']",
  description: "Login link",
  method: "click",
};

describe("guardedAct", () => {
  it("returns ActResult verbatim on the happy path", async () => {
    const stagehand = fakeStagehandAct(VALID_ACT_RESULT);
    const result = await guardedAct(stagehand, "click submit");
    expect(result).toEqual(VALID_ACT_RESULT);
  });

  it("records a successful capture entry with callType=stagehand-act", async () => {
    const stagehand = fakeStagehandAct(VALID_ACT_RESULT);
    await guardedAct(stagehand, "click submit");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.callType).toBe("stagehand-act");
    expect(captured[0]?.parsedOk).toBe(true);
    expect(captured[0]?.success).toBe(true);
    expect(captured[0]?.userContent).toBe("click submit");
  });

  it("uses Action.description as userContent when passed an Action input", async () => {
    const stagehand = fakeStagehandAct(VALID_ACT_RESULT);
    await guardedAct(stagehand, VALID_ACTION);
    expect(captured[0]?.userContent).toBe(VALID_ACTION.description);
  });

  // Locks in the no-coercion contract: the wrapper must forward the Action
  // object verbatim to Stagehand.act. A future refactor that runs the input
  // through String() or JSON.stringify() before passing to act would fail
  // this test. A type-only `as string` cast would NOT — Stagehand's runtime
  // dispatches via isObserveResult, so the mock would still see the Action
  // object verbatim. The runtime-coercion case is the meaningful one to
  // guard against.
  it("forwards the Action object to stagehand.act, not a coerced string", async () => {
    const stagehand = fakeStagehandAct(VALID_ACT_RESULT);
    await guardedAct(stagehand, VALID_ACTION);
    expect(stagehand.act).toHaveBeenCalledWith(VALID_ACTION, undefined);
  });

  it("forwards a string instruction to stagehand.act directly", async () => {
    const stagehand = fakeStagehandAct(VALID_ACT_RESULT);
    await guardedAct(stagehand, "click submit");
    expect(stagehand.act).toHaveBeenCalledWith("click submit", undefined);
  });

  it("throws StagehandSchemaError when the return envelope drifts", async () => {
    const malformed = { success: "not-a-boolean" };
    const stagehand = fakeStagehandAct(malformed);
    await expect(guardedAct(stagehand, "click submit")).rejects.toBeInstanceOf(
      StagehandSchemaError
    );
  });

  it("records failureKind=schema-validation-failed on envelope drift", async () => {
    const malformed = { success: "not-a-boolean" };
    const stagehand = fakeStagehandAct(malformed);
    await expect(guardedAct(stagehand, "click submit")).rejects.toThrow();
    expect(captured).toHaveLength(1);
    expect(captured[0]?.failureKind).toBe("schema-validation-failed");
    expect(captured[0]?.parsedOk).toBe(false);
  });

  it("propagates underlying Stagehand exceptions and records failureKind", async () => {
    const stagehand = {
      act: vi.fn().mockRejectedValue(new Error("network error")),
    } as unknown as Stagehand;
    await expect(guardedAct(stagehand, "click submit")).rejects.toThrow("network error");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.success).toBe(false);
    expect(captured[0]?.errorMessage).toContain("network error");
  });

  // Per-run NDJSON sink plumbing: a caller can inject a `captureFn` so
  // its telemetry lands in the run-specific NDJSON instead of the default
  // global `.barnacle/calls.ndjson`. Without this, every Stagehand entry
  // landed in the global sink and hid the `instanceId` regression for the
  // entire pre-2026-06-11 ship.
  it("routes telemetry to caller-supplied captureFn when supplied", async () => {
    const stagehand = fakeStagehandAct(VALID_ACT_RESULT);
    const injected: LlmCallInput[] = [];
    await guardedAct(stagehand, "click submit", undefined, async (input) => {
      injected.push(input);
    });
    expect(injected).toHaveLength(1);
    expect(injected[0]?.callType).toBe("stagehand-act");
    expect(captured).toHaveLength(0);
  });

  // guardedAct accepts a trailing frameTarget for signature symmetry with
  // guardedObserve/guardedExtract, but ActOptions has no selector field and
  // its page override can't accept a Frame handle — so a resolved
  // frameTarget must NOT change what's forwarded to stagehand.act.
  it("does not forward a resolved frameTarget into ActOptions", async () => {
    const stagehand = fakeStagehandAct(VALID_ACT_RESULT);
    const frameTarget = fakeChildFrameTarget("iframe#apply_frame");
    await guardedAct(stagehand, "click submit", { timeout: 5000 }, undefined, frameTarget);
    expect(stagehand.act).toHaveBeenCalledWith("click submit", { timeout: 5000 });
  });

  it("records the same success telemetry under a frame scope as the no-frame path", async () => {
    const stagehand = fakeStagehandAct(VALID_ACT_RESULT);
    const frameTarget = fakeChildFrameTarget("iframe#apply_frame");
    await guardedAct(stagehand, "click submit", undefined, undefined, frameTarget);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.callType).toBe("stagehand-act");
    expect(captured[0]?.parsedOk).toBe(true);
    expect(captured[0]?.success).toBe(true);
    expect(captured[0]?.failureKind).toBeNull();
  });

  it("propagates underlying Stagehand exceptions and records failureKind under a frame scope", async () => {
    const stagehand = {
      act: vi.fn().mockRejectedValue(new Error("network error")),
    } as unknown as Stagehand;
    const frameTarget = fakeChildFrameTarget("iframe#apply_frame");
    await expect(
      guardedAct(stagehand, "click submit", undefined, undefined, frameTarget)
    ).rejects.toThrow("network error");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.success).toBe(false);
    expect(captured[0]?.errorMessage).toContain("network error");
  });
});

describe("guardedObserve", () => {
  it("returns Action[] verbatim on the happy path", async () => {
    const stagehand = fakeStagehandObserve([VALID_ACTION]);
    const result = await guardedObserve(stagehand, "find a login link");
    expect(result).toEqual([VALID_ACTION]);
  });

  it("supports the no-instruction overload", async () => {
    const stagehand = fakeStagehandObserve([VALID_ACTION]);
    const result = await guardedObserve(stagehand);
    expect(result).toEqual([VALID_ACTION]);
    expect(captured[0]?.userContent).toBe("");
  });

  // Regression guards for F3: the wrapper has a nested ternary that picks
  // between observe()'s three runtime overloads (no args, options only,
  // instruction + options). Each test verifies the right one fires.
  it("dispatches observe() with no args when only stagehand is passed", async () => {
    const stagehand = fakeStagehandObserve([VALID_ACTION]);
    await guardedObserve(stagehand);
    expect(stagehand.observe).toHaveBeenCalledWith();
  });

  it("dispatches observe(options) when only options are passed", async () => {
    const stagehand = fakeStagehandObserve([VALID_ACTION]);
    await guardedObserve(stagehand, undefined, { timeout: 5000 });
    expect(stagehand.observe).toHaveBeenCalledWith({ timeout: 5000 });
  });

  it("dispatches observe(instruction, options) when both are passed", async () => {
    const stagehand = fakeStagehandObserve([VALID_ACTION]);
    await guardedObserve(stagehand, "find a login link", { timeout: 5000 });
    expect(stagehand.observe).toHaveBeenCalledWith("find a login link", { timeout: 5000 });
  });

  it("records callType=stagehand-observe on success", async () => {
    const stagehand = fakeStagehandObserve([VALID_ACTION]);
    await guardedObserve(stagehand, "find a login link");
    expect(captured[0]?.callType).toBe("stagehand-observe");
    expect(captured[0]?.parsedOk).toBe(true);
  });

  it("throws StagehandSchemaError when an element is not an Action shape", async () => {
    const malformed = [{ description: "missing selector" }];
    const stagehand = fakeStagehandObserve(malformed);
    await expect(guardedObserve(stagehand, "find something")).rejects.toBeInstanceOf(
      StagehandSchemaError
    );
    expect(captured[0]?.failureKind).toBe("schema-validation-failed");
  });

  it("forwards a resolved frameTarget's frameSelector as ObserveOptions.selector in hop notation", async () => {
    const stagehand = fakeStagehandObserve([VALID_ACTION]);
    const frameTarget = fakeChildFrameTarget("iframe#apply_frame");
    await guardedObserve(stagehand, "find something", undefined, undefined, frameTarget);
    expect(stagehand.observe).toHaveBeenCalledWith("find something", {
      selector: "iframe#apply_frame >> *",
    });
  });

  it("merges frameTarget.frameSelector into existing options without a selector, in hop notation", async () => {
    const stagehand = fakeStagehandObserve([VALID_ACTION]);
    const frameTarget = fakeChildFrameTarget("iframe#apply_frame");
    await guardedObserve(stagehand, "find something", { timeout: 5000 }, undefined, frameTarget);
    expect(stagehand.observe).toHaveBeenCalledWith("find something", {
      timeout: 5000,
      selector: "iframe#apply_frame >> *",
    });
  });

  it("prefers a caller-supplied options.selector over frameTarget.frameSelector", async () => {
    const stagehand = fakeStagehandObserve([VALID_ACTION]);
    const frameTarget = fakeChildFrameTarget("iframe#apply_frame");
    await guardedObserve(
      stagehand,
      "find something",
      { selector: "input#explicit" },
      undefined,
      frameTarget
    );
    expect(stagehand.observe).toHaveBeenCalledWith("find something", {
      selector: "input#explicit",
    });
  });

  it("leaves options byte-identical to today when frameTarget is the main frame", async () => {
    const stagehand = fakeStagehandObserve([VALID_ACTION]);
    const frameTarget = fakeMainFrameTarget();
    await guardedObserve(stagehand, "find something", { timeout: 5000 }, undefined, frameTarget);
    expect(stagehand.observe).toHaveBeenCalledWith("find something", { timeout: 5000 });
  });

  it("leaves options undefined when frameTarget is the main frame and no options are passed", async () => {
    const stagehand = fakeStagehandObserve([VALID_ACTION]);
    const frameTarget = fakeMainFrameTarget();
    await guardedObserve(stagehand, "find something", undefined, undefined, frameTarget);
    expect(stagehand.observe).toHaveBeenCalledWith("find something", undefined);
  });

  // Proves the frame scope changes what's RETURNED, not just what's
  // forwarded: matches the real 69-top-frame-candidate bug, where observe()
  // must come back with the frame's own candidates instead of the page's.
  it("returns only the scoped frame's candidates when a frame scope is supplied", async () => {
    const topCandidates = [VALID_ACTION];
    const frameAction: Action = {
      selector: "xpath=//input[@id='firstName']",
      description: "First name field",
      method: "fill",
    };
    const stagehand = fakeStagehandObserveByScope(topCandidates, [frameAction]);
    const frameTarget = fakeChildFrameTarget("iframe#apply_frame");
    const result = await guardedObserve(
      stagehand,
      "find something",
      undefined,
      undefined,
      frameTarget
    );
    expect(result).toEqual([frameAction]);
    expect(result).not.toEqual(topCandidates);
  });

  it("returns the page's own candidates verbatim when no frame scope is supplied", async () => {
    const topCandidates = [VALID_ACTION];
    const frameAction: Action = {
      selector: "xpath=//input[@id='firstName']",
      description: "First name field",
      method: "fill",
    };
    const stagehand = fakeStagehandObserveByScope(topCandidates, [frameAction]);
    const result = await guardedObserve(stagehand, "find something");
    expect(result).toEqual(topCandidates);
  });

  it("still throws StagehandSchemaError on envelope drift under a frame scope", async () => {
    const malformed = [{ description: "missing selector" }];
    const stagehand = fakeStagehandObserve(malformed);
    const frameTarget = fakeChildFrameTarget("iframe#apply_frame");
    await expect(
      guardedObserve(stagehand, "find something", undefined, undefined, frameTarget)
    ).rejects.toBeInstanceOf(StagehandSchemaError);
    expect(captured[0]?.failureKind).toBe("schema-validation-failed");
  });
});

describe("guardedExtract", () => {
  const PERSON_SCHEMA = z.object({
    name: z.string(),
    age: z.number().int().min(0),
  });

  it("returns the typed payload on the happy path", async () => {
    const stagehand = fakeStagehandExtract({ name: "Alice", age: 30 });
    const result = await guardedExtract(stagehand, "extract person", PERSON_SCHEMA);
    expect(result).toEqual({ name: "Alice", age: 30 });
    // Type-narrowing sanity: TypeScript inferred result as { name: string; age: number }
    expect(typeof result.name).toBe("string");
    expect(typeof result.age).toBe("number");
  });

  it("records callType=stagehand-extract on success", async () => {
    const stagehand = fakeStagehandExtract({ name: "Alice", age: 30 });
    await guardedExtract(stagehand, "extract person", PERSON_SCHEMA);
    expect(captured[0]?.callType).toBe("stagehand-extract");
    expect(captured[0]?.parsedOk).toBe(true);
    expect(captured[0]?.userContent).toBe("extract person");
  });

  it("throws StagehandSchemaError when the payload doesn't match the schema", async () => {
    const stagehand = fakeStagehandExtract({ name: "Alice", age: "thirty" });
    await expect(guardedExtract(stagehand, "extract person", PERSON_SCHEMA)).rejects.toBeInstanceOf(
      StagehandSchemaError
    );
    expect(captured[0]?.failureKind).toBe("schema-validation-failed");
  });

  it("forwards a resolved frameTarget's frameSelector as ExtractOptions.selector in hop notation", async () => {
    const stagehand = fakeStagehandExtract({ name: "Alice", age: 30 });
    const frameTarget = fakeChildFrameTarget("iframe#apply_frame");
    await guardedExtract(
      stagehand,
      "extract person",
      PERSON_SCHEMA,
      undefined,
      undefined,
      frameTarget
    );
    expect(stagehand.extract).toHaveBeenCalledWith("extract person", PERSON_SCHEMA, {
      selector: "iframe#apply_frame >> *",
    });
  });

  it("prefers a caller-supplied options.selector over frameTarget.frameSelector", async () => {
    const stagehand = fakeStagehandExtract({ name: "Alice", age: 30 });
    const frameTarget = fakeChildFrameTarget("iframe#apply_frame");
    await guardedExtract(
      stagehand,
      "extract person",
      PERSON_SCHEMA,
      { selector: "div#explicit" },
      undefined,
      frameTarget
    );
    expect(stagehand.extract).toHaveBeenCalledWith("extract person", PERSON_SCHEMA, {
      selector: "div#explicit",
    });
  });

  it("leaves options untouched when frameTarget is the main frame", async () => {
    const stagehand = fakeStagehandExtract({ name: "Alice", age: 30 });
    const frameTarget = fakeMainFrameTarget();
    await guardedExtract(
      stagehand,
      "extract person",
      PERSON_SCHEMA,
      undefined,
      undefined,
      frameTarget
    );
    expect(stagehand.extract).toHaveBeenCalledWith("extract person", PERSON_SCHEMA, undefined);
  });

  // Proves the frame scope changes what's RETURNED, not just what's
  // forwarded: matches the observe contract above for the extract overload.
  it("returns only the scoped frame's payload when a frame scope is supplied", async () => {
    const topPayload = { name: "Alice", age: 30 };
    const framePayload = { name: "Bob", age: 45 };
    const stagehand = fakeStagehandExtractByScope(topPayload, framePayload);
    const frameTarget = fakeChildFrameTarget("iframe#apply_frame");
    const result = await guardedExtract(
      stagehand,
      "extract person",
      PERSON_SCHEMA,
      undefined,
      undefined,
      frameTarget
    );
    expect(result).toEqual(framePayload);
    expect(result).not.toEqual(topPayload);
  });

  it("returns the page's own payload verbatim when no frame scope is supplied", async () => {
    const topPayload = { name: "Alice", age: 30 };
    const framePayload = { name: "Bob", age: 45 };
    const stagehand = fakeStagehandExtractByScope(topPayload, framePayload);
    const result = await guardedExtract(stagehand, "extract person", PERSON_SCHEMA);
    expect(result).toEqual(topPayload);
  });

  it("still throws StagehandSchemaError on payload drift under a frame scope", async () => {
    const stagehand = fakeStagehandExtract({ name: "Alice", age: "thirty" });
    const frameTarget = fakeChildFrameTarget("iframe#apply_frame");
    await expect(
      guardedExtract(stagehand, "extract person", PERSON_SCHEMA, undefined, undefined, frameTarget)
    ).rejects.toBeInstanceOf(StagehandSchemaError);
    expect(captured[0]?.failureKind).toBe("schema-validation-failed");
  });
});

// Regression coverage for the deepLocator-hang signature: `STEP_WATCHDOG_MS`
// is passed to Stagehand as an advisory `timeout`, but nothing previously
// raced the await — a wedged act/observe/extract blocked the step forever.
describe("guard timeouts", () => {
  const PERSON_SCHEMA = z.object({
    name: z.string(),
    age: z.number().int().min(0),
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("guardedAct rejects within options.timeout when stagehand.act never settles", async () => {
    const stagehand = fakeStagehandActHung();
    const assertion = expect(
      guardedAct(stagehand, "click submit", { timeout: 5000 })
    ).rejects.toMatchObject({ name: "WatchdogTimeoutError" });
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });

  it("guardedAct forwards the exact args to stagehand.act even though the call hangs", async () => {
    const stagehand = fakeStagehandActHung();
    const assertion = expect(
      guardedAct(stagehand, "click submit", { timeout: 5000 })
    ).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(stagehand.act).toHaveBeenCalledWith("click submit", { timeout: 5000 });
  });

  it("guardedAct records the timeout as a failed call with a valid failureKind", async () => {
    const stagehand = fakeStagehandActHung();
    const assertion = expect(
      guardedAct(stagehand, "click submit", { timeout: 5000 })
    ).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(captured).toHaveLength(1);
    expect(captured[0]?.success).toBe(false);
    expect(captured[0]?.parsedOk).toBe(false);
    expect(captured[0]?.failureKind).toBe("exception-other");
  });

  it("guardedObserve rejects within options.timeout when stagehand.observe never settles", async () => {
    const stagehand = fakeStagehandObserveHung();
    const assertion = expect(
      guardedObserve(stagehand, "find something", { timeout: 5000 })
    ).rejects.toMatchObject({ name: "WatchdogTimeoutError" });
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });

  it("guardedObserve forwards the exact args to stagehand.observe even though the call hangs", async () => {
    const stagehand = fakeStagehandObserveHung();
    const assertion = expect(
      guardedObserve(stagehand, "find something", { timeout: 5000 })
    ).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(stagehand.observe).toHaveBeenCalledWith("find something", { timeout: 5000 });
  });

  it("guardedObserve records the timeout as a failed call with a valid failureKind", async () => {
    const stagehand = fakeStagehandObserveHung();
    const assertion = expect(
      guardedObserve(stagehand, "find something", { timeout: 5000 })
    ).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(captured).toHaveLength(1);
    expect(captured[0]?.success).toBe(false);
    expect(captured[0]?.parsedOk).toBe(false);
    expect(captured[0]?.failureKind).toBe("exception-other");
  });

  it("guardedExtract rejects within options.timeout when stagehand.extract never settles", async () => {
    const stagehand = fakeStagehandExtractHung();
    const assertion = expect(
      guardedExtract(stagehand, "extract person", PERSON_SCHEMA, { timeout: 5000 })
    ).rejects.toMatchObject({ name: "WatchdogTimeoutError" });
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });

  it("guardedExtract forwards the exact args to stagehand.extract even though the call hangs", async () => {
    const stagehand = fakeStagehandExtractHung();
    const assertion = expect(
      guardedExtract(stagehand, "extract person", PERSON_SCHEMA, { timeout: 5000 })
    ).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(stagehand.extract).toHaveBeenCalledWith("extract person", PERSON_SCHEMA, {
      timeout: 5000,
    });
  });

  it("guardedExtract records the timeout as a failed call with a valid failureKind", async () => {
    const stagehand = fakeStagehandExtractHung();
    const assertion = expect(
      guardedExtract(stagehand, "extract person", PERSON_SCHEMA, { timeout: 5000 })
    ).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(captured).toHaveLength(1);
    expect(captured[0]?.success).toBe(false);
    expect(captured[0]?.parsedOk).toBe(false);
    expect(captured[0]?.failureKind).toBe("exception-other");
  });

  it("falls back to DEFAULT_GUARD_TIMEOUT_MS when the caller passes no options.timeout", async () => {
    const stagehand = fakeStagehandActHung();
    const assertion = expect(guardedAct(stagehand, "click submit")).rejects.toMatchObject({
      name: "WatchdogTimeoutError",
      timeoutMs: 120_000,
    });
    await vi.advanceTimersByTimeAsync(120_000);
    await assertion;
  });
});
