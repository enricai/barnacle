/**
 * Shared shadow-aware XPath resolver, as page-injectable source text.
 *
 * Stagehand emits `//` between a custom-element host and an element rendered
 * inside its open shadow root (e.g. `//shop-app//button[@id="buy"]`). The
 * native `document.evaluate` cannot cross a shadow boundary, so such an xpath
 * resolves to nothing. This resolver tries the native lookup first (a plain
 * light-DOM xpath resolves exactly as before) and, only when that finds
 * nothing, walks each `//` segment through the matched nodes and every open
 * shadow root beneath them.
 *
 * The text evaluates to a function `(xpath: string) => Element | null`. Embed
 * it in an in-page expression with {@link shadowXpathLookupExpr}.
 */
export const SHADOW_XPATH_RESOLVER_SRC = `((xpath) => {
  const first = (expr, ctx) => {
    try {
      return document.evaluate(expr, ctx, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
    } catch (e) { return null; }
  };
  const all = (expr, ctx) => {
    const out = [];
    try {
      const r = document.evaluate(expr, ctx, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      for (let i = 0; i < r.snapshotLength; i++) out.push(r.snapshotItem(i));
    } catch (e) { /* invalid expression: no matches */ }
    return out;
  };
  const native = first(xpath, document);
  if (native || xpath.indexOf("//") < 0) return native;
  const parts = [];
  let depth = 0, quote = "", cur = "";
  for (let i = 0; i < xpath.length; i++) {
    const c = xpath[i];
    if (quote) { if (c === quote) quote = ""; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === "[" || c === "(") depth++;
    else if (c === "]" || c === ")") depth--;
    else if (depth === 0 && c === "/" && xpath[i + 1] === "/") { parts.push(cur); cur = ""; i++; continue; }
    cur += c;
  }
  parts.push(cur);
  // Roots to search under a node: the node itself plus the open shadow root of
  // the node and of every descendant.
  const roots = (node) => {
    const out = [node];
    const walk = (n) => {
      if (n.shadowRoot) { out.push(n.shadowRoot); walk(n.shadowRoot); }
      for (const ch of n.querySelectorAll ? n.querySelectorAll("*") : []) {
        if (ch.shadowRoot) { out.push(ch.shadowRoot); walk(ch.shadowRoot); }
      }
    };
    walk(node);
    return out;
  };
  let ctxs = [document];
  for (let k = 0; k < parts.length; k++) {
    const part = parts[k];
    if (k === 0 && part === "") continue;
    const next = [];
    for (const ctx of ctxs) {
      for (const root of roots(ctx)) {
        const add = (expr, c) => { for (const n of all(expr, c)) if (next.indexOf(n) < 0) next.push(n); };
        if (k === 0) { add(part, root); continue; }
        if (root === document) { add("//" + part, root); continue; }
        if (root.nodeType !== 11) { add(".//" + part, root); continue; }
        // A ShadowRoot is not a valid XPath context node: search from each of
        // its element children, and test the child itself via self::.
        const selfOk = /^[A-Za-z_*][^:\\[\\/]*(\\[|\\/|$)/.test(part);
        for (const c of Array.from(root.children)) {
          if (selfOk) add("self::" + part, c);
          add(".//" + part, c);
        }
      }
    }
    if (next.length === 0) return null;
    ctxs = next;
  }
  return ctxs[0] === document ? null : ctxs[0];
})`;

/** In-page expression that resolves `xpath` to its first element (or null), piercing open shadow roots. */
export function shadowXpathLookupExpr(xpath: string): string {
  return `(${SHADOW_XPATH_RESOLVER_SRC})(${JSON.stringify(xpath)})`;
}
