/**
 * Invalid-fields detection judge. Replaces the framework-conventional
 * regex `INVALID_CLASS_RX` (matching Angular ng-invalid, Material
 * mat-form-field-invalid, Bootstrap is-invalid, etc) with a Haiku 4.5
 * structured-output call.
 *
 * Why: the regex covered Angular and Bootstrap conventions but silently
 * missed React Hook Form (aria-invalid attribute), Mantine (data-invalid),
 * Chakra (aria-invalid), HTML5 native :invalid (no class added), Tailwind
 * form libraries, and arbitrary site-specific markers. When the regex
 * missed, the rephrase prompt saw `(none)` in its FORM FIELDS section and
 * the cascade lost the V4-C redirect signal.
 *
 * The judge looks at a body-HTML excerpt + a list of structured field
 * candidates (tag + class + aria attributes) and decides whether each
 * candidate is structurally invalid (class containing "invalid",
 * aria-invalid="true", data-invalid, or near a semantic error container).
 * Visual-only styling does NOT count.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod/v4";

import { callHaikuJudge, type JudgeCaptureFn } from "@/lib/llm/judge";
import { INVALID_FIELDS_SCHEMA } from "@/lib/llm/schemas";
import { CALL_TYPE_JUDGE_INVALID_FIELDS } from "@/lib/telemetry/call-types";

const INVALID_FIELDS_SYSTEM_PROMPT = `You are a strict invalid-field detector for browser forms. Given a body-HTML excerpt and (optionally) site-specific class-name prefixes, identify form fields that are structurally in an invalid/error state.

Strict criteria for present=true (mark a field):
- The container has a class containing "invalid" (e.g. ng-invalid, mat-form-field-invalid, is-invalid, field-invalid, app-input-invalid, etc.), OR
- The element has aria-invalid="true", OR
- The element has data-invalid (truthy), OR
- The container is structurally adjacent to an error-message container (class containing "error", "validation", "feedback", "required", "help-block-error", etc.), OR
- The element is structurally adjacent to a visible error-text span/div that explains why it's invalid.

Do NOT mark a field when:
- Only visual styling indicates error (red border via CSS, no semantic marker).
- The container is in a pristine/untouched state (e.g. ng-pristine ng-untouched alongside ng-invalid means the user hasn't interacted yet — that's a "may become invalid" state, not currently invalid).
- The element is a hidden input or non-interactive ancestor.
- The container is invalid ONLY because a descendant is invalid (parent-bubbled invalidity). Angular bubbles ng-invalid up to wrapping forms / lists / question containers; Bootstrap mirrors this on form-group; React Hook Form propagates aria-invalid through fieldsets. When you see <ol class="ng-invalid"> with <li class="ng-valid"> children where ONE deeper descendant is actually invalid, report ONLY the deepest leaf that carries the failure. The leaf is the smallest container with the invalid marker AND no further invalid descendants. Reporting bubbled parents alongside the real leaf creates false positives (the parent's children look like they're invalid when they are not).

When the supplied knownErrorClassPrefixes list is non-empty, also treat class names starting with any of those prefixes followed by "-invalid" or "-error" as structural markers (site-specific convention).

Return up to 50 fields. Top-level present=true means at least one field is currently invalid. present=false means no structural invalid markers found anywhere in the excerpt.

Each field entry:
- containerXpath: a best-effort xpath identifying the container (tag + nth-of-type)
- label: the visible label text near the field, or null if not discoverable
- markerKind: which marker type triggered ("class", "aria", "data", "error-container", "other")
- framework: which UI library this looks like ("angular", "react", "vue", "mantine", "chakra", "bootstrap", "other"). Look at framework-conventional class signatures to decide.`;

export interface JudgeInvalidFieldsInput {
  /** Body HTML excerpt to scan (typically the page DOM, truncated to ~8KB). */
  bodyHtmlExcerpt: string;
  /** Site-supplied class-name prefixes that wrap error/invalid state (e.g. ["uapp-", "app-"]). */
  knownErrorClassPrefixes: readonly string[];
}

function buildInvalidFieldsPrompt(input: JudgeInvalidFieldsInput): string {
  return `Identify form fields currently in an invalid/error state.

KNOWN ERROR-CLASS PREFIXES (site-specific, optional): ${JSON.stringify(input.knownErrorClassPrefixes)}

BODY HTML EXCERPT:
${input.bodyHtmlExcerpt}`;
}

/**
 * Run the invalid-fields judge. Returns the parsed verdict (a list of
 * detected invalid containers + a top-level present boolean). Returns null
 * when the client is null (Bedrock-only) or when the API call fails —
 * callers fall back to a conservative "no invalid markers detected" default.
 */
export async function judgeInvalidFieldsWithLLM(params: {
  client: Anthropic | null;
  input: JudgeInvalidFieldsInput;
  captureFn?: JudgeCaptureFn;
}): Promise<z.infer<typeof INVALID_FIELDS_SCHEMA> | null> {
  const { client, input, captureFn } = params;
  if (client === null) return null;
  const result = await callHaikuJudge({
    client,
    systemPrompt: INVALID_FIELDS_SYSTEM_PROMPT,
    userPrompt: buildInvalidFieldsPrompt(input),
    schema: INVALID_FIELDS_SCHEMA,
    callType: CALL_TYPE_JUDGE_INVALID_FIELDS,
    captureFn,
  });
  return result?.parsed ?? null;
}

export { INVALID_FIELDS_SYSTEM_PROMPT };
