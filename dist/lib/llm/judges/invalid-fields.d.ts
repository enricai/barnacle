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
import { type JudgeCaptureFn } from "../../../lib/llm/judge";
import { INVALID_FIELDS_SCHEMA } from "../../../lib/llm/schemas";
declare const INVALID_FIELDS_SYSTEM_PROMPT = "You are a strict invalid-field detector for browser forms. Given a body-HTML excerpt and (optionally) site-specific class-name prefixes, identify form fields that are structurally in an invalid/error state.\n\nStrict criteria for present=true (mark a field):\n- The container has a class containing \"invalid\" (e.g. ng-invalid, mat-form-field-invalid, is-invalid, field-invalid, app-input-invalid, etc.), OR\n- The element has aria-invalid=\"true\", OR\n- The element has data-invalid (truthy), OR\n- The container is structurally adjacent to an error-message container (class containing \"error\", \"validation\", \"feedback\", \"required\", \"help-block-error\", etc.), OR\n- The element is structurally adjacent to a visible error-text span/div that explains why it's invalid.\n\nDo NOT mark a field when:\n- Only visual styling indicates error (red border via CSS, no semantic marker).\n- The container is in a pristine/untouched state (e.g. ng-pristine ng-untouched alongside ng-invalid means the user hasn't interacted yet \u2014 that's a \"may become invalid\" state, not currently invalid).\n- The element is a hidden input or non-interactive ancestor.\n\nWhen the supplied knownErrorClassPrefixes list is non-empty, also treat class names starting with any of those prefixes followed by \"-invalid\" or \"-error\" as structural markers (site-specific convention).\n\nReturn up to 50 fields. Top-level present=true means at least one field is currently invalid. present=false means no structural invalid markers found anywhere in the excerpt.\n\nEach field entry:\n- containerXpath: a best-effort xpath identifying the container (tag + nth-of-type)\n- label: the visible label text near the field, or null if not discoverable\n- markerKind: which marker type triggered (\"class\", \"aria\", \"data\", \"error-container\", \"other\")\n- framework: which UI library this looks like (\"angular\", \"react\", \"vue\", \"mantine\", \"chakra\", \"bootstrap\", \"other\"). Look at framework-conventional class signatures to decide.";
export interface JudgeInvalidFieldsInput {
    /** Body HTML excerpt to scan (typically the page DOM, truncated to ~8KB). */
    bodyHtmlExcerpt: string;
    /** Site-supplied class-name prefixes that wrap error/invalid state (e.g. ["uapp-", "app-"]). */
    knownErrorClassPrefixes: readonly string[];
}
/**
 * Run the invalid-fields judge. Returns the parsed verdict (a list of
 * detected invalid containers + a top-level present boolean). Returns null
 * when the client is null (Bedrock-only) or when the API call fails —
 * callers fall back to a conservative "no invalid markers detected" default.
 */
export declare function judgeInvalidFieldsWithLLM(params: {
    client: Anthropic | null;
    input: JudgeInvalidFieldsInput;
    captureFn?: JudgeCaptureFn;
}): Promise<z.infer<typeof INVALID_FIELDS_SCHEMA> | null>;
export { INVALID_FIELDS_SYSTEM_PROMPT };
