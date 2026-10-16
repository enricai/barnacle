/**
 * In-page helpers shared by the date-segment enumeration and the fill
 * readback so "is this spinbutton one segment of a multi-segment widget" has a
 * single definition; defines `spins`, `ownerOf` and `isDateSegment`.
 */
export const SEGMENT_OWNER_JS = `
  const hiddenAttr = (node) => node.hasAttribute("hidden") || node.getAttribute("aria-hidden") === "true";
  const styleOf = (node) => {
    try { return typeof getComputedStyle === "function" ? getComputedStyle(node) : window.getComputedStyle(node); } catch { return null; }
  };
  const isHidden = (el) => {
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      if (hiddenAttr(node)) return true;
      const style = styleOf(node);
      if (style && (style.display === "none" || style.visibility === "hidden")) return true;
    }
    return false;
  };
  const spins = Array.from(document.querySelectorAll("input[role='spinbutton']")).filter((el) => !isHidden(el));
  const norm = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const idText = (ids) => (ids || "").split(/\\s+/).map((id) => {
    const ref = id ? document.getElementById(id) : null;
    return ref ? norm(ref.textContent) : "";
  }).join(" ");
  const legendOf = (node) => {
    const legend = node.tagName === "FIELDSET" ? node.querySelector(":scope > legend") : null;
    return legend ? norm(legend.textContent) : "";
  };
  const namedBy = (node) => [legendOf(node), norm(node.getAttribute("aria-label")), idText(node.getAttribute("aria-labelledby"))].filter(Boolean).join(" ");
  const tiedToSpin = (l) => l.querySelector("input,[role='spinbutton']") || (l.getAttribute("for") && spins.some((sp) => sp.id === l.getAttribute("for")));
  const hasCaption = (node) => namedBy(node) !== "" || Array.from(node.querySelectorAll("label,legend")).some((l) => !tiedToSpin(l));
  const captionOwnerOf = (el) => {
    const explicit = el.closest("fieldset,[role='group']");
    if (explicit) return explicit;
    for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
      if (hasCaption(node)) return node;
    }
    return null;
  };
  const bareSpins = spins.filter((sp) => !captionOwnerOf(sp));
  const hasOtherControl = (node) => Array.from(node.querySelectorAll("input,select,textarea")).some((c) => !spins.includes(c) && c.type !== "hidden");
  // Segments that each sit in their own uncaptioned wrapper share no
  // fieldset/caption, so the nearest ancestor holding several bare spinbuttons
  // (and no other form control) is the widget they belong to.
  const bareOwnerOf = (el) => {
    for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
      if (hasOtherControl(node)) break;
      if (bareSpins.filter((sp) => node.contains(sp)).length > 1) return node;
    }
    return el.parentElement;
  };
  const ownerOf = (el) => captionOwnerOf(el) || bareOwnerOf(el);
  const isDateSegment = (el) => {
    if (!el.getAttribute || el.getAttribute("role") !== "spinbutton" || !spins.includes(el)) return false;
    const box = ownerOf(el);
    return spins.filter((sp) => ownerOf(sp) === box).length > 1;
  };
`;

/**
 * Expression evaluated with `this` as a resolved element; lets actuation code
 * decide before writing whether the element is one segment of a multi-segment
 * date widget, using the same detector the enumeration and readback use.
 */
export const IS_DATE_SEGMENT_EXPR = `(function () {
  ${SEGMENT_OWNER_JS}
  return isDateSegment(this);
})`;
