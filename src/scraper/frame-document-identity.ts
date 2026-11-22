/**
 * Frame document identity: `performance.timeOrigin` is fixed per document
 * load, so a different value means the frame's document was replaced (e.g. by
 * navigation) since the identity was captured. Used to guard retries that
 * would otherwise re-apply a stale positional selector to a new document.
 */

/** Anything with a string-expression `evaluate` (Page, Frame). */
export interface EvaluateTarget {
  evaluate<R>(pageFunctionOrExpression: string): Promise<R>;
}

/** A document identity, or null when it could not be read. */
export type FrameDocumentIdentity = number | null;

export const FRAME_DOCUMENT_IDENTITY_EXPR = "performance.timeOrigin";

/** Reads the identity; any failure or non-finite value yields null. */
export async function readFrameDocumentIdentity(
  target: EvaluateTarget
): Promise<FrameDocumentIdentity> {
  try {
    const v = await target.evaluate<unknown>(FRAME_DOCUMENT_IDENTITY_EXPR);
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

export type FrameDocumentStatus = "current" | "replaced" | "unknown";

/** Compares a captured identity against the target's present one. */
export async function checkFrameDocumentIdentity(
  target: EvaluateTarget,
  before: FrameDocumentIdentity
): Promise<FrameDocumentStatus> {
  if (before === null) return "unknown";
  const now = await readFrameDocumentIdentity(target);
  if (now === null) return "unknown";
  return now === before ? "current" : "replaced";
}
