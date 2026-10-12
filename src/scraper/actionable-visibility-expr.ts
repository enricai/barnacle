/**
 * Single browser-context predicate (as an evaluable function-expression
 * string) deciding whether an element is a legitimate click target. It
 * exists so every click-target consumer shares one definition: an
 * `aria-hidden="true"` decorative duplicate sharing text with the real
 * control must never be scanned, ranked or clicked. Only the element's own
 * attribute is checked — ancestors commonly carry `aria-hidden` on app-root
 * containers behind modals — and `tabindex="-1"` is deliberately not
 * excluded because focus-managed custom controls use it legitimately.
 */
export const ACTIONABLE_VISIBILITY_EXPR = `((el) => {
  if (!el) return false;
  if (el.getAttribute("aria-hidden") === "true") return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  const style = getComputedStyle(el);
  return style.display !== "none" && style.visibility !== "hidden";
})`;
