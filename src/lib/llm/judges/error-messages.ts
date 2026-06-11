/**
 * Error-messages extraction judge. Replaces the framework-conventional
 * regex `errorPattern = /(error-message|mat-error|field-error|...)/` over
 * DOM class signatures.
 *
 * Why: same shape as the invalid-fields judge. The regex covered Angular
 * and Material conventions but missed React Hook Form render-prop errors,
 * headless UI component-based errors, toast-based error notifications,
 * inline tooltip errors, and any site-specific error container class.
 * When the regex missed, the rephrase prompt's VISIBLE ERROR section
 * was `(none)` and the LLM lost the structured field-level rejection
 * messages the server had returned.
 *
 * The judge extracts structurally-marked error messages with optional
 * field hints and severity. Visual-only error styling does NOT count.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod/v4";

import { callHaikuJudge, type JudgeCaptureFn } from "@/lib/llm/judge";
import { ERROR_MESSAGES_SCHEMA } from "@/lib/llm/schemas";
import { CALL_TYPE_JUDGE_ERROR_MESSAGES } from "@/lib/telemetry/call-types";

const ERROR_MESSAGES_SYSTEM_PROMPT = `You are a strict error-message extractor for browser forms. Given a body-HTML excerpt, identify visible error messages and required-field warnings tied to specific form inputs.

Strict criteria for extracting a message:
- It lives inside a structural error container (class containing "error", "validation", "feedback", "invalid", "required", "help-block-error", "form-error", or app-prefixed equivalent), OR
- It's inside an aria-live="polite" or aria-live="assertive" region, OR
- It's directly adjacent to a field marked aria-invalid="true" or data-invalid.

Do NOT extract:
- Placeholder text inside empty inputs (placeholder= attribute).
- Help text / hint text that's always visible and explains the field (e.g. "Format: MM/DD/YYYY").
- Tooltips that auto-hide on click outside.
- Plain prose text that happens to contain words like "error" but isn't a structural error indicator.

Each message:
- text: the visible message string, trimmed to ≤400 chars.
- fieldHint: a short identifier for the field the error applies to (label text, placeholder, name= attribute, id), or null if not discoverable.
- severity: "error" for structural validation failures, "warning" for soft hints (e.g. "field will be required"), "info" for purely informational adjacent messages.

Return up to 50 messages. Empty array when no structural error containers are visible.`;

export interface JudgeErrorMessagesInput {
  /** Body HTML excerpt to scan (typically the page DOM, truncated to ~8KB). */
  bodyHtmlExcerpt: string;
}

function buildErrorMessagesPrompt(input: JudgeErrorMessagesInput): string {
  return `Extract visible structurally-marked error messages from this excerpt.

BODY HTML EXCERPT:
${input.bodyHtmlExcerpt}`;
}

/**
 * Run the error-messages judge. Returns a list of structurally-marked
 * error messages with field hints and severity. Returns null when the
 * client is null (Bedrock-only) or the API call fails — callers fall back
 * to an empty list.
 */
export async function judgeErrorMessagesWithLLM(params: {
  client: Anthropic | null;
  input: JudgeErrorMessagesInput;
  captureFn?: JudgeCaptureFn;
}): Promise<z.infer<typeof ERROR_MESSAGES_SCHEMA> | null> {
  const { client, input, captureFn } = params;
  if (client === null) return null;
  if (input.bodyHtmlExcerpt.length === 0) return null;
  const result = await callHaikuJudge({
    client,
    systemPrompt: ERROR_MESSAGES_SYSTEM_PROMPT,
    userPrompt: buildErrorMessagesPrompt(input),
    schema: ERROR_MESSAGES_SCHEMA,
    callType: CALL_TYPE_JUDGE_ERROR_MESSAGES,
    captureFn,
  });
  return result?.parsed ?? null;
}

export { ERROR_MESSAGES_SYSTEM_PROMPT };
