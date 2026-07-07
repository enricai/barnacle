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

const SELECT_OPTION_SYSTEM_PROMPT = `You are a job applicant answering a required screening dropdown on an application form. You are given a QUESTION, a HINT at the intended answer (from a generic template that may not match this specific job), and SEVERAL candidate dropdowns on the page — each with its own list of options. Exactly one dropdown (or none) is the one that answers the question.

Do two things:
1. Pick the dropdown (selectIndex) whose options actually answer the QUESTION. E.g. a nursing-education question is answered by a dropdown whose options are education levels, NOT one whose options are disability choices or countries. If NO dropdown's options fit the question, return selectIndex=null.
2. Within that dropdown, pick the option (optionIndex) that is the most plausible, truthful answer letting a qualified candidate proceed:
   - Prefer the option semantically closest to the hint (e.g. hint "Emergency Department" on a cardiac role → the closest clinical specialty available).
   - For EEO / self-identification / voluntary demographic questions (race, gender, disability, veteran status), prefer a decline option ("I do not wish to answer", "Prefer not to answer", "Decline to self-identify").
   - For yes/no eligibility questions, choose the answer that keeps a qualified candidate eligible (usually the hint).
   - NEVER choose a disabled placeholder ("Please select…", "-- Select --", empty first entry).

Return selectIndex = the 0-based index into the candidate dropdowns (or null if none fit), optionIndex = the 0-based index into THAT dropdown's options (null if selectIndex is null). Always give a one-line reason.`;

export interface JudgeSelectOptionCandidate {
  /** The dropdown's nearby/associated label text, when discoverable. */
  label: string | null;
  /** The dropdown's real option texts, in DOM order (index-aligned). */
  options: readonly string[];
}

export interface JudgeSelectOptionInput {
  /** The question being answered (from the flow step). */
  questionLabel: string | null;
  /** The flow's intended answer text (may not exist in any dropdown). */
  desiredHint: string;
  /** Candidate dropdowns on the page (unfilled ones), index-aligned. */
  candidates: readonly JudgeSelectOptionCandidate[];
}

function buildSelectOptionPrompt(input: JudgeSelectOptionInput): string {
  const blocks = input.candidates
    .map((c, si) => {
      const opts = c.options.map((o, oi) => `    ${oi}. ${o}`).join("\n");
      return `DROPDOWN ${si}${c.label ? ` (label: ${c.label})` : ""}:\n${opts}`;
    })
    .join("\n\n");
  return `QUESTION: ${input.questionLabel ?? "(no label discoverable)"}

INTENDED ANSWER (hint, may not match): ${input.desiredHint}

CANDIDATE DROPDOWNS (pick the one that answers the question, then an option in it):
${blocks}`;
}

/**
 * Run the select-option picker. Returns the parsed verdict — which candidate
 * dropdown (selectIndex) answers the question and which option in it
 * (optionIndex), or both null when no dropdown fits. Returns null when the
 * client is null (Bedrock-only) or the API call fails — the caller then falls
 * through to the cascade instead of applying a guess. Both indices are bounds-
 * checked against the supplied candidates before returning.
 */
export async function judgeSelectOptionWithLLM(params: {
  client: Anthropic | null;
  input: JudgeSelectOptionInput;
  captureFn?: JudgeCaptureFn;
}): Promise<z.infer<typeof SELECT_OPTION_SCHEMA> | null> {
  const { client, input, captureFn } = params;
  if (client === null) return null;
  if (input.candidates.length === 0) return null;
  const result = await callHaikuJudge({
    client,
    systemPrompt: SELECT_OPTION_SYSTEM_PROMPT,
    userPrompt: buildSelectOptionPrompt(input),
    schema: SELECT_OPTION_SCHEMA,
    callType: CALL_TYPE_JUDGE_SELECT_OPTION,
    captureFn,
  });
  const parsed = result?.parsed ?? null;
  if (!parsed || parsed.selectIndex === null) return parsed;
  // Guard both indices against the supplied candidates — a hallucinated
  // out-of-range index must not index past the arrays in the caller.
  const nullVerdict = (reason: string): z.infer<typeof SELECT_OPTION_SCHEMA> => ({
    selectIndex: null,
    optionIndex: null,
    reason,
  });
  const chosenCandidate = input.candidates[parsed.selectIndex];
  if (!chosenCandidate) {
    return nullVerdict(`LLM selectIndex ${parsed.selectIndex} out of range`);
  }
  if (parsed.optionIndex === null || parsed.optionIndex >= chosenCandidate.options.length) {
    return nullVerdict(
      `LLM optionIndex ${parsed.optionIndex} out of range for dropdown ${parsed.selectIndex}`
    );
  }
  return parsed;
}

export { SELECT_OPTION_SYSTEM_PROMPT };
