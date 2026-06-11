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
import { type JudgeCaptureFn } from "../../../lib/llm/judge";
import { ERROR_MESSAGES_SCHEMA } from "../../../lib/llm/schemas";
declare const ERROR_MESSAGES_SYSTEM_PROMPT = "You are a strict error-message extractor for browser forms. Given a body-HTML excerpt, identify visible error messages and required-field warnings tied to specific form inputs.\n\nStrict criteria for extracting a message:\n- It lives inside a structural error container (class containing \"error\", \"validation\", \"feedback\", \"invalid\", \"required\", \"help-block-error\", \"form-error\", or app-prefixed equivalent), OR\n- It's inside an aria-live=\"polite\" or aria-live=\"assertive\" region, OR\n- It's directly adjacent to a field marked aria-invalid=\"true\" or data-invalid.\n\nDo NOT extract:\n- Placeholder text inside empty inputs (placeholder= attribute).\n- Help text / hint text that's always visible and explains the field (e.g. \"Format: MM/DD/YYYY\").\n- Tooltips that auto-hide on click outside.\n- Plain prose text that happens to contain words like \"error\" but isn't a structural error indicator.\n\nEach message:\n- text: the visible message string, trimmed to \u2264400 chars.\n- fieldHint: a short identifier for the field the error applies to (label text, placeholder, name= attribute, id), or null if not discoverable.\n- severity: \"error\" for structural validation failures, \"warning\" for soft hints (e.g. \"field will be required\"), \"info\" for purely informational adjacent messages.\n\nReturn up to 50 messages. Empty array when no structural error containers are visible.";
export interface JudgeErrorMessagesInput {
    /** Body HTML excerpt to scan (typically the page DOM, truncated to ~8KB). */
    bodyHtmlExcerpt: string;
}
/**
 * Run the error-messages judge. Returns a list of structurally-marked
 * error messages with field hints and severity. Returns null when the
 * client is null (Bedrock-only) or the API call fails — callers fall back
 * to an empty list.
 */
export declare function judgeErrorMessagesWithLLM(params: {
    client: Anthropic | null;
    input: JudgeErrorMessagesInput;
    captureFn?: JudgeCaptureFn;
}): Promise<z.infer<typeof ERROR_MESSAGES_SCHEMA> | null>;
export { ERROR_MESSAGES_SYSTEM_PROMPT };
