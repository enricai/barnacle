const EXCLUDE_SOURCE = "\\b(later|skip|without|remove|delete|cancel|decline)\\b";
const NO_FILE_SOURCE = "\\bno files?\\b";
const POSITIVE_SOURCE =
  "\\b(uploads?|browse|(select|choose) files?|attach|add (a )?(resumes?|cvs?|files?)|resumes?/cvs?)\\b";

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

/**
 * Controls that can carry an upload-affordance label. Shared by the render-gate
 * and the click so a `role="link"` "Choose files" control is seen by both.
 */
export const UPLOAD_AFFORDANCE_CONTROL_SELECTOR = "button,[role='button'],[role='link'],a";

const DROP_ZONE_ATTRIBUTE_VALUE_SOURCE =
  "drop[-_ ]?(zone|area|target|file|upload|resume)|(file|upload|resume)[-_ ]?drop(?!-?down)";

/**
 * Browser-evaluable function expression `(document) => Element | null` that
 * finds a drop area. Tries the class/tag/attribute selectors first, then scans
 * every element's attributes (any name, any value) so a drop area identified
 * only by e.g. `data-area="file-drop"` is still found. Shared by the render-gate
 * and the synthetic drag-drop so the two cannot disagree about what a drop area is.
 */
export const FIND_DROP_ZONE_EXPR = `((doc) => {
  const bySelector = doc.querySelector(${JSON.stringify(DROP_ZONE_SELECTORS.join(","))});
  if (bySelector) return bySelector;
  if (typeof doc.querySelectorAll !== "function") return null;
  const valueRe = new RegExp(${JSON.stringify(DROP_ZONE_ATTRIBUTE_VALUE_SOURCE)}, "i");
  const skip = new Set(["html", "head", "body", "script", "style", "input", "option"]);
  for (const el of Array.from(doc.querySelectorAll("*"))) {
    if (!el.attributes || skip.has(String(el.tagName || "").toLowerCase())) continue;
    for (const attr of Array.from(el.attributes)) {
      if (attr.name === "class") continue;
      if (valueRe.test(attr.name) || valueRe.test(attr.value || "")) return el;
    }
  }
  return null;
})`;
