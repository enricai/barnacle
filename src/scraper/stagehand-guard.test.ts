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
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

import type { LlmCallInput } from "@/lib/telemetry/call-capture";

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
  newObserveCache,
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
});

describe("ObserveCache", () => {
  const VALID_ACTION: Action = {
    selector: "xpath=//button",
    description: "Login button",
    method: "click",
    arguments: [],
  };

  it("starts empty with zeroed stats", () => {
    const cache = newObserveCache();
    expect(cache.byInstruction.size).toBe(0);
    expect(cache.stats).toEqual({ hits: 0, misses: 0, invalidations: 0 });
  });

  it("populates on miss then returns the cached Action[] on hit without calling Stagehand again", async () => {
    const cache = newObserveCache();
    const stagehand = fakeStagehandObserve([VALID_ACTION]);
    // First call: miss → real observe
    const first = await guardedObserve(stagehand, "find login", undefined, undefined, cache);
    expect(first).toEqual([VALID_ACTION]);
    expect(cache.stats.misses).toBe(1);
    expect(cache.stats.hits).toBe(0);
    expect(stagehand.observe).toHaveBeenCalledTimes(1);
    // Second call: hit → cached, Stagehand not called again
    const second = await guardedObserve(stagehand, "find login", undefined, undefined, cache);
    expect(second).toEqual([VALID_ACTION]);
    expect(cache.stats.misses).toBe(1);
    expect(cache.stats.hits).toBe(1);
    expect(stagehand.observe).toHaveBeenCalledTimes(1);
  });

  it("bypasses the cache for unfocused observes (no instruction)", async () => {
    const cache = newObserveCache();
    const stagehand = fakeStagehandObserve([VALID_ACTION]);
    await guardedObserve(stagehand, undefined, undefined, undefined, cache);
    await guardedObserve(stagehand, undefined, undefined, undefined, cache);
    // No hits, no misses — undefined-instruction paths skip the cache entirely
    expect(cache.stats.hits).toBe(0);
    expect(cache.stats.misses).toBe(0);
    expect(stagehand.observe).toHaveBeenCalledTimes(2);
  });

  it("bypasses the cache when ignoreSelectors is set (cascade attempt 4)", async () => {
    const cache = newObserveCache();
    const stagehand = fakeStagehandObserve([VALID_ACTION]);
    await guardedObserve(
      stagehand,
      "find login",
      { ignoreSelectors: ["xpath=//x"] },
      undefined,
      cache
    );
    expect(cache.stats.misses).toBe(0);
    expect(cache.stats.hits).toBe(0);
    expect(stagehand.observe).toHaveBeenCalledTimes(1);
  });

  it("guardedAct invalidates cache entries containing the clicked selector on success", async () => {
    const cache = newObserveCache();
    cache.byInstruction.set("yes/no for question A", [VALID_ACTION]);
    cache.byInstruction.set("yes/no for question B", [VALID_ACTION]);
    const stagehand = fakeStagehandAct({
      success: true,
      message: "clicked",
      actionDescription: "Yes label",
      actions: [VALID_ACTION],
    });
    await guardedAct(stagehand, "click yes", undefined, undefined, cache);
    expect(cache.byInstruction.size).toBe(0);
    expect(cache.stats.invalidations).toBe(2);
  });

  it("guardedAct does NOT invalidate on success=false", async () => {
    const cache = newObserveCache();
    cache.byInstruction.set("find login", [VALID_ACTION]);
    const stagehand = fakeStagehandAct({
      success: false,
      message: "No action found",
      actionDescription: "click attempt",
      actions: [VALID_ACTION],
    });
    await guardedAct(stagehand, "click missing", undefined, undefined, cache);
    expect(cache.byInstruction.has("find login")).toBe(true);
    expect(cache.stats.invalidations).toBe(0);
  });
});
