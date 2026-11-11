import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RephraseModel } from "@/lib/llm/anthropic-client";

const generateObject = vi.fn();
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateObject: (...args: unknown[]) => generateObject(...args) };
});

import {
  appendClearBeforeTypeClause,
  CLEAR_BEFORE_TYPE_CLAUSE,
  rephraseWithLLM,
} from "./flow-runner";

const model = { modelId: "test-model" } as unknown as RephraseModel;

function respond(instruction: string, typesIntoField: boolean): void {
  generateObject.mockResolvedValue({
    object: { outcome: "rewrite", instruction, typesIntoField },
    usage: { inputTokens: 1, outputTokens: 1 },
  });
}

function rephrase(): Promise<string | null> {
  return rephraseWithLLM(model, "Fill the Email field", [], [], ["no effect"], async () => {});
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("appendClearBeforeTypeClause", () => {
  it("appends the clause once, replacing trailing punctuation", () => {
    expect(appendClearBeforeTypeClause("Type a@example.com into the Email field.")).toBe(
      `Type a@example.com into the Email field${CLEAR_BEFORE_TYPE_CLAUSE}`
    );
  });

  it("is idempotent", () => {
    const once = appendClearBeforeTypeClause("Click the email input and type a@example.com");
    expect(appendClearBeforeTypeClause(once)).toBe(once);
  });
});

describe("rephraseWithLLM clears before typing only when the model says the rewrite types into a field", () => {
  beforeEach(() => {
    generateObject.mockReset();
  });

  it("appends the clause exactly once when typesIntoField is true", async () => {
    respond("Type user@example.com into the Email field", true);
    const out = await rephrase();
    expect(out).toBe(`Type user@example.com into the Email field${CLEAR_BEFORE_TYPE_CLAUSE}`);
    expect(occurrences(out ?? "", CLEAR_BEFORE_TYPE_CLAUSE)).toBe(1);
  });

  it("does not append a second clause when the rewrite already ends with it", async () => {
    respond(`Type user@example.com into the Email field${CLEAR_BEFORE_TYPE_CLAUSE}`, true);
    const out = await rephrase();
    expect(occurrences(out ?? "", CLEAR_BEFORE_TYPE_CLAUSE)).toBe(1);
  });

  it("leaves the instruction unchanged when typesIntoField is false", async () => {
    respond("Click the Country dropdown and choose Norway", false);
    expect(await rephrase()).toBe("Click the Country dropdown and choose Norway");
  });

  it("does not append a second clause when the rewrite ends with it plus punctuation", async () => {
    respond(`Type user@example.com into the Email field${CLEAR_BEFORE_TYPE_CLAUSE}.\n`, true);
    const out = await rephrase();
    expect(occurrences(out ?? "", CLEAR_BEFORE_TYPE_CLAUSE)).toBe(1);
  });

  it("leaves 'Press Enter to submit the form' unchanged when typesIntoField is false", async () => {
    respond("Press Enter to submit the form", false);
    expect(await rephrase()).toBe("Press Enter to submit the form");
  });

  it("returns null for outcome=impossible", async () => {
    generateObject.mockResolvedValue({
      object: { outcome: "impossible", reason: "nothing else to click" },
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    expect(await rephrase()).toBeNull();
  });
});
