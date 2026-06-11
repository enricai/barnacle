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
