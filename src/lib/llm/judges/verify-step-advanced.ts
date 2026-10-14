/**
 * Non-final step judge. A mid-flow click (e.g. creating an account at a store
 * checkout) has no success confirmation to find, so the strict submit judge
 * is the wrong question; this one asks only whether the page moved past the
 * step's form. Title and URL are deliberately not inputs: a single-page app's
 * title is stale and the URL is often unchanged.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod/v4";

import { callHaikuJudge, type JudgeCaptureFn } from "@/lib/llm/judge";
import { STEP_ADVANCED_SCHEMA } from "@/lib/llm/schemas";
import { CALL_TYPE_JUDGE_SUBMIT_VERIFY } from "@/lib/telemetry/call-types";

const MAX_TEXT_CHARS = 3000;
const MAX_REASON_CHARS = 400;

const STEP_ADVANCED_SYSTEM_PROMPT = `You decide whether a browser-automated flow moved past a mid-flow step after a click. You are given the step instruction, the visible page text BEFORE the click, and the visible page text AFTER it.

Set advanced=true only when the AFTER text shows the flow moved on: a different step or heading is showing and the fields the step asked to fill (present in the BEFORE text) are gone.
Set advanced=false when the AFTER text still shows the same form, shows validation or error messages, or the DOM invalid-marker count is above zero.
When ambiguous, set advanced=false.
Write one short sentence as the reason.`;

/** Inputs for the step-advanced judge. */
export interface VerifyStepAdvancedInput {
  stepInstruction: string;
  beforeText: string;
  afterText: string;
  invalidMarkerCount: number;
}

function buildPrompt(input: VerifyStepAdvancedInput): string {
  return `Did the page advance past this step?

STEP INSTRUCTION: ${input.stepInstruction}

BEFORE TEXT (truncated):
${input.beforeText.slice(0, MAX_TEXT_CHARS)}

AFTER TEXT (truncated):
${input.afterText.slice(0, MAX_TEXT_CHARS)}

DOM INVALID-MARKER COUNT: ${input.invalidMarkerCount}`;
}

/**
 * Judge whether a non-final step's click advanced the flow, without demanding
 * final-submit success evidence. Returns null for a null client or failed call.
 */
export async function verifyStepAdvancedWithLLM(params: {
  client: Anthropic | null;
  input: VerifyStepAdvancedInput;
  captureFn?: JudgeCaptureFn;
}): Promise<z.infer<typeof STEP_ADVANCED_SCHEMA> | null> {
  const { client, input, captureFn } = params;
  if (client === null) return null;
  const result = await callHaikuJudge({
    client,
    systemPrompt: STEP_ADVANCED_SYSTEM_PROMPT,
    userPrompt: buildPrompt(input),
    schema: STEP_ADVANCED_SCHEMA,
    callType: CALL_TYPE_JUDGE_SUBMIT_VERIFY,
    captureFn,
  });
  if (!result) return null;
  return {
    advanced: result.parsed.advanced,
    reason: result.parsed.reason.slice(0, MAX_REASON_CHARS),
  };
}

export { STEP_ADVANCED_SYSTEM_PROMPT };
