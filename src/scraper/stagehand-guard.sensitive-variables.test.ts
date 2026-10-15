/**
 * Request values listed in a plugin's `tokenizeKeys` must reach Stagehand only as
 * `variables` (substituted when
 * the action is performed), never inside the instruction the LLM, the
 * Browserbase API cache or the call telemetry sees — while callers still get
 * back actions carrying the real values, since they replay them directly.
 */

import type { Action, Stagehand } from "@browserbasehq/stagehand";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RephraseModel } from "@/lib/llm/anthropic-client";
import { registerSensitiveValues, resetSensitiveValuesForTests } from "@/lib/pii-redaction";
import { generateThrowawayPassword } from "@/lib/random";
import type { LlmCallInput } from "@/lib/telemetry/call-capture";
import type { RedactionPolicy } from "@/types/pii-redaction";

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

const generateObject = vi.fn();
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateObject: (...args: unknown[]) => generateObject(...args) };
});

import { rephraseWithLLM } from "@/scraper/flow-runner";
import { guardedAct, guardedObserve } from "@/scraper/stagehand-guard";

const REQUEST = {
  JobId: "JOB-1",
  FirstName: "Will",
  LastName: "Sentinelson",
  Email: "will.sentinel@example.com",
  Phone: "+15559876543",
  City: "Springfield",
};

const POLICY: RedactionPolicy = {
  persistKeys: ["JobId"],
  wordKeys: ["FirstName", "LastName", "Email", "City"],
  digitKeys: ["Phone"],
  tokenizeKeys: ["FirstName", "LastName", "Email", "Phone"],
};

const VALUE_PATTERN = /Will\b|Sentinelson|will\.sentinel@example\.com|9876543/;

function actResult(args: string[]): unknown {
  return {
    success: true,
    message: "done",
    actionDescription: "filled the input",
    actions: [
      { selector: "xpath=/html/body/input", description: "input", method: "fill", arguments: args },
    ],
  };
}

beforeEach(() => {
  captured.length = 0;
  registerSensitiveValues("run-1", REQUEST, POLICY);
});

afterEach(() => {
  resetSensitiveValuesForTests();
  generateObject.mockReset();
});

describe("guardedAct sensitive variables", () => {
  it("sends %tokens% plus a variables map and returns the real values", async () => {
    const act = vi.fn().mockResolvedValue(actResult(["%Email%"]));
    const stagehand = { act } as unknown as Stagehand;

    const result = await guardedAct(stagehand, `Fill in the Email field with '${REQUEST.Email}'`, {
      timeout: 1000,
    });

    expect(act).toHaveBeenCalledWith("Fill in the Email field with '%Email%'", {
      timeout: 1000,
      variables: { Email: REQUEST.Email },
    });
    expect(result.actions[0]?.arguments).toEqual([REQUEST.Email]);
    expect(JSON.stringify(captured)).not.toMatch(VALUE_PATTERN);
    expect(captured[0]?.userContent).toBe("Fill in the Email field with '%Email%'");
  });

  it("tokenizes a generated throwaway password", async () => {
    const password = generateThrowawayPassword();
    const act = vi.fn().mockResolvedValue(actResult(["%Secret%"]));

    const result = await guardedAct(
      { act } as unknown as Stagehand,
      `Fill in the Password field with '${password}'`
    );

    expect(act.mock.calls[0]?.[0]).toBe("Fill in the Password field with '%Secret%'");
    expect(act.mock.calls[0]?.[1]).toEqual({ variables: { Secret: password } });
    expect(result.actions[0]?.arguments).toEqual([password]);
    expect(JSON.stringify(captured)).not.toContain(password);
  });

  it("leaves keys outside tokenizeKeys, and names outside value positions, untouched", async () => {
    const act = vi.fn().mockResolvedValue(actResult([]));
    const instruction =
      "Click the 'No' answer for 'Will you require sponsorship?' then fill the City field with 'Springfield'";

    await guardedAct({ act } as unknown as Stagehand, instruction);

    expect(act).toHaveBeenCalledWith(instruction, undefined);
  });

  it("tokenizes nothing for a plugin that did not opt in", async () => {
    resetSensitiveValuesForTests();
    registerSensitiveValues("run-1", REQUEST);
    const act = vi.fn().mockResolvedValue(actResult([REQUEST.Email]));
    const instruction = `Fill in the Email field with '${REQUEST.Email}'`;

    await guardedAct({ act } as unknown as Stagehand, instruction);

    expect(act).toHaveBeenCalledWith(instruction, undefined);
  });

  it("passes an observed Action through unchanged", async () => {
    const act = vi.fn().mockResolvedValue(actResult([REQUEST.Email]));
    const action: Action = {
      selector: "xpath=/html/body/input",
      description: "Email input",
      method: "fill",
      arguments: [REQUEST.Email],
    };

    await guardedAct({ act } as unknown as Stagehand, action);

    expect(act).toHaveBeenCalledWith(action, undefined);
  });

  it("is byte-identical to before when no run is registered", async () => {
    resetSensitiveValuesForTests();
    const act = vi.fn().mockResolvedValue(actResult([REQUEST.Email]));
    const instruction = `Fill in the Email field with '${REQUEST.Email}'`;

    await guardedAct({ act } as unknown as Stagehand, instruction, { timeout: 5 });

    expect(act).toHaveBeenCalledWith(instruction, { timeout: 5 });
  });
});

describe("guardedObserve sensitive variables", () => {
  it("sends tokens with withheld variable values and resolves returned arguments", async () => {
    const observe = vi.fn().mockResolvedValue([
      {
        selector: "xpath=/a",
        description: "First name input for %FirstName%",
        method: "fill",
        arguments: ["%firstname%"],
      },
    ]);

    const actions = await guardedObserve(
      { observe } as unknown as Stagehand,
      `Find the First Name input to fill with '${REQUEST.FirstName}'`
    );

    expect(observe).toHaveBeenCalledWith("Find the First Name input to fill with '%FirstName%'", {
      variables: { FirstName: "" },
    });
    expect(actions).toEqual([
      {
        selector: "xpath=/a",
        description: "First name input for Will",
        method: "fill",
        arguments: ["Will"],
      },
    ]);
    expect(JSON.stringify(captured)).not.toMatch(VALUE_PATTERN);
  });

  it("drops an action whose argument is a token the guard never issued", async () => {
    const observe = vi.fn().mockResolvedValue([
      { selector: "xpath=/a", description: "a", method: "fill", arguments: ["%Password%"] },
      { selector: "xpath=/b", description: "b", method: "fill", arguments: ["%Email%"] },
    ]);

    const actions = await guardedObserve(
      { observe } as unknown as Stagehand,
      `Find the Email input to fill with '${REQUEST.Email}'`
    );

    expect(actions.map((a) => a.arguments)).toEqual([[REQUEST.Email]]);
  });

  it("keeps an action whose argument carries percent-encoded URL text", async () => {
    const encoded = "https://example.com/apply?next=%E2%80%99";
    const observe = vi
      .fn()
      .mockResolvedValue([
        { selector: "xpath=/a", description: "a", method: "fill", arguments: [encoded] },
      ]);

    const actions = await guardedObserve(
      { observe } as unknown as Stagehand,
      `Find the Email input to fill with '${REQUEST.Email}'`
    );

    expect(actions.map((a) => a.arguments)).toEqual([[encoded]]);
  });
});

describe("rephraseWithLLM sensitive variables", () => {
  const model = { modelId: "test-model" } as unknown as RephraseModel;

  function respond(instruction: string): void {
    generateObject.mockResolvedValue({
      object: { outcome: "rewrite", instruction },
      usage: { inputTokens: 1, outputTokens: 1 },
    });
  }

  it("keeps values out of the prompt and resolves tokens in the rewrite", async () => {
    respond("Type %LastName% into the input labelled Last name");
    const capture = vi.fn().mockResolvedValue(undefined);

    const rewritten = await rephraseWithLLM(
      model,
      `Fill in the Last Name field with '${REQUEST.LastName}'`,
      [],
      [],
      ["no effect"],
      capture
    );

    const prompt = (generateObject.mock.calls[0]?.[0] as { prompt: string } | undefined)?.prompt;
    expect(prompt).toContain("'%LastName%'");
    expect(prompt).not.toMatch(VALUE_PATTERN);
    expect(JSON.stringify(capture.mock.calls)).not.toMatch(VALUE_PATTERN);
    expect(rewritten).toBe("Type Sentinelson into the input labelled Last name");
  });

  it("rejects a rewrite that cites an unknown token", async () => {
    respond("Fill the Password field with %Password%");

    const rewritten = await rephraseWithLLM(
      model,
      `Fill in the Last Name field with '${REQUEST.LastName}'`,
      [],
      [],
      ["no effect"],
      vi.fn().mockResolvedValue(undefined)
    );

    expect(rewritten).toBeNull();
  });
});
