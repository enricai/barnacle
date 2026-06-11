"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.INVALID_FIELDS_SYSTEM_PROMPT = void 0;
exports.judgeInvalidFieldsWithLLM = judgeInvalidFieldsWithLLM;
const judge_1 = require("../../../lib/llm/judge");
const schemas_1 = require("../../../lib/llm/schemas");
const call_types_1 = require("../../../lib/telemetry/call-types");
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

When the supplied knownErrorClassPrefixes list is non-empty, also treat class names starting with any of those prefixes followed by "-invalid" or "-error" as structural markers (site-specific convention).

Return up to 50 fields. Top-level present=true means at least one field is currently invalid. present=false means no structural invalid markers found anywhere in the excerpt.

Each field entry:
- containerXpath: a best-effort xpath identifying the container (tag + nth-of-type)
- label: the visible label text near the field, or null if not discoverable
- markerKind: which marker type triggered ("class", "aria", "data", "error-container", "other")
- framework: which UI library this looks like ("angular", "react", "vue", "mantine", "chakra", "bootstrap", "other"). Look at framework-conventional class signatures to decide.`;
exports.INVALID_FIELDS_SYSTEM_PROMPT = INVALID_FIELDS_SYSTEM_PROMPT;
function buildInvalidFieldsPrompt(input) {
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
async function judgeInvalidFieldsWithLLM(params) {
    const { client, input, captureFn } = params;
    if (client === null)
        return null;
    const result = await (0, judge_1.callHaikuJudge)({
        client,
        systemPrompt: INVALID_FIELDS_SYSTEM_PROMPT,
        userPrompt: buildInvalidFieldsPrompt(input),
        schema: schemas_1.INVALID_FIELDS_SCHEMA,
        callType: call_types_1.CALL_TYPE_JUDGE_INVALID_FIELDS,
        captureFn,
    });
    return result?.parsed ?? null;
}
//# sourceMappingURL=invalid-fields.js.map