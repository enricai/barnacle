/**
 * Select-option picker judge. When a recon flow step hardcodes a dropdown
 * answer (e.g. "select 'Emergency Department'") but that exact option does
 * not exist in a given requisition's option list — different jobs render
 * different screening-question options — this judge chooses the most
 * plausible AVAILABLE option so the required question is answered and the
 * multi-page wizard can advance.
 *
 * Why an LLM (not fuzzy string match): the gap is semantic, not lexical. An
 * "Emergency Department" hint on a Cardiac requisition has near-zero string
 * overlap with the real options (CVICU, Progressive Care, …) yet a human
 * would pick the closest clinically-plausible one. Deterministic overlap
 * would pick nothing or the wrong option. This is the "LLM-chosen, correct
 * real submission" policy the answers land in the ATS under.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod/v4";

import { callHaikuJudge, type JudgeCaptureFn } from "@/lib/llm/judge";
import { SELECT_OPTION_SCHEMA } from "@/lib/llm/schemas";
import { CALL_TYPE_JUDGE_SELECT_OPTION } from "@/lib/telemetry/call-types";

const SELECT_OPTION_SYSTEM_PROMPT = `You are a job applicant answering a required screening dropdown on an application form. You are given the question, a HINT at the intended answer (from a generic template that may not match this specific job), and the ACTUAL list of options available in the dropdown.

Choose the index of the single most plausible, truthful option that lets a qualified candidate proceed:
- Prefer the option semantically closest to the hint (e.g. hint "Emergency Department" on a cardiac role → the closest clinical specialty available).
- For EEO / self-identification / voluntary demographic questions (race, gender, disability, veteran status), prefer a decline option ("I do not wish to answer", "Prefer not to answer", "Decline to self-identify").
- For yes/no eligibility questions, choose the answer that keeps a qualified candidate eligible (usually the hint).
- NEVER choose a disabled placeholder option (e.g. "Please select…", "-- Select --", an empty first entry).

Return chosenIndex = the 0-based index into the availableOptions array. Return chosenIndex = null ONLY when no option is a valid answer to the question. Always give a one-line reason.`;

export interface JudgeSelectOptionInput {
  /** The question the dropdown answers, when discoverable (else null). */
  questionLabel: string | null;
  /** The flow's intended answer text (may not exist in availableOptions). */
  desiredHint: string;
  /** The dropdown's real option texts, in DOM order (index-aligned). */
  availableOptions: readonly string[];
}

function buildSelectOptionPrompt(input: JudgeSelectOptionInput): string {
  const optionLines = input.availableOptions.map((o, i) => `${i}. ${o}`).join("\n");
  return `QUESTION: ${input.questionLabel ?? "(no label discoverable)"}

INTENDED ANSWER (hint, may not match): ${input.desiredHint}

AVAILABLE OPTIONS (choose one by index):
${optionLines}`;
}

/**
 * Run the select-option picker. Returns the parsed verdict (a chosenIndex
 * into the supplied availableOptions, or null when no option fits). Returns
 * null when the client is null (Bedrock-only) or the API call fails — the
 * caller then falls through to the cascade instead of applying a guess.
 */
export async function judgeSelectOptionWithLLM(params: {
  client: Anthropic | null;
  input: JudgeSelectOptionInput;
  captureFn?: JudgeCaptureFn;
}): Promise<z.infer<typeof SELECT_OPTION_SCHEMA> | null> {
  const { client, input, captureFn } = params;
  if (client === null) return null;
  if (input.availableOptions.length === 0) return null;
  const result = await callHaikuJudge({
    client,
    systemPrompt: SELECT_OPTION_SYSTEM_PROMPT,
    userPrompt: buildSelectOptionPrompt(input),
    schema: SELECT_OPTION_SCHEMA,
    callType: CALL_TYPE_JUDGE_SELECT_OPTION,
    captureFn,
  });
  const parsed = result?.parsed ?? null;
  // Guard the index against the supplied option count — a hallucinated
  // out-of-range index must not index past the array in the caller.
  if (
    parsed &&
    parsed.chosenIndex !== null &&
    parsed.chosenIndex >= input.availableOptions.length
  ) {
    return { chosenIndex: null, reason: `LLM index ${parsed.chosenIndex} out of range` };
  }
  return parsed;
}

export { SELECT_OPTION_SYSTEM_PROMPT };
