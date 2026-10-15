const EXCLUDE_SOURCE = "\\b(later|skip|without|remove|delete|cancel)\\b";
const NO_FILE_SOURCE = "\\bno file\\b";
const POSITIVE_SOURCE =
  "\\b(upload|browse|(select|choose) files?|attach|add (a )?(resume|cv|files?)|resume/cv)\\b";

/**
 * Normalised-label predicate for the Node side. It exists so the Node
 * matcher and the browser expression derive from the same regex sources and
 * cannot drift (a singular-only copy once missed "Select files").
 */
export function matchesUploadAffordanceVocabulary(label: string): boolean {
  const norm = label.replace(/\s+/g, " ").trim().toLowerCase();
  if (norm.length === 0) return false;
  if (new RegExp(EXCLUDE_SOURCE).test(norm)) return false;
  if (new RegExp(NO_FILE_SOURCE).test(norm)) return false;
  return new RegExp(POSITIVE_SOURCE).test(norm);
}

/**
 * Browser-evaluable function-expression string giving the same verdicts as
 * {@link matchesUploadAffordanceVocabulary}, for interpolation into
 * `page.evaluate` template literals.
 */
export const UPLOAD_AFFORDANCE_MATCHER_EXPR = `((raw) => {
  const t = (raw || "").replace(/\\s+/g, " ").trim().toLowerCase();
  if (!t) return false;
  if (new RegExp(${JSON.stringify(EXCLUDE_SOURCE)}).test(t)) return false;
  if (new RegExp(${JSON.stringify(NO_FILE_SOURCE)}).test(t)) return false;
  return new RegExp(${JSON.stringify(POSITIVE_SOURCE)}).test(t);
})`;

const DROP_ZONE_ATTRIBUTES = [
  "data-testid",
  "data-test",
  "data-test-id",
  "data-qa",
  "data-cy",
  "id",
];

/**
 * Single drop-zone selector list shared by the render-gate and the synthetic
 * drag-drop so the two cannot disagree about what a drop area is. Besides
 * class substrings and custom tags it matches drop areas identified only by an
 * attribute (e.g. `data-testid="file-drop-area"`).
 */
export const DROP_ZONE_SELECTORS: readonly string[] = [
  "uapp-upload",
  "app-upload",
  "uapp-resume-upload",
  "[class*='dropzone']",
  "[class*='drop-zone']",
  "[class*='file-drop']",
  "[class*='upload-zone']",
  "[class*='uapp-upload']",
  "[class*='ResumeUpload']",
  "[class*='resumeUpload']",
  "[class*='resume-upload']",
  ...DROP_ZONE_ATTRIBUTES.flatMap((attr) =>
    ["file", "upload"].map((word) => `[${attr}*='drop' i][${attr}*='${word}' i]`)
  ),
];
