/**
 * Pure robots.txt parser (RFC 9309 subset): only the `User-agent: *` group is
 * honoured; Disallow/Allow use prefix matching with `*` and `$`, longest rule wins, and
 * Allow wins a tie. No network access here — the caller fetches the body.
 * Example: "User-agent: *\nDisallow: /order" blocks https://example.com/order.
 */
export interface RobotsRule {
  allow: boolean;
  path: string;
}

export function parseRobots(body: string): RobotsRule[] {
  const rules: RobotsRule[] = [];
  let inGroup = false;
  let lastWasAgent = false;
  let groupMatches = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === "user-agent") {
      if (!lastWasAgent) {
        inGroup = true;
        groupMatches = false;
      }
      if (value === "*") groupMatches = true;
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!inGroup || !groupMatches) continue;
    if (key === "disallow" || key === "allow") {
      if (value === "") continue; // empty rule matches nothing
      rules.push({ allow: key === "allow", path: value });
    }
  }
  return rules;
}

/** RFC 9309 §2.2.3: `*` matches any run of characters, trailing `$` anchors the end. */
function ruleMatches(rule: string, path: string): boolean {
  if (!rule.includes("*") && !rule.endsWith("$")) return path.startsWith(rule);
  const anchored = rule.endsWith("$");
  const body = anchored ? rule.slice(0, -1) : rule;
  const re = body
    .split("*")
    .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${re}${anchored ? "$" : ""}`).test(path);
}

/** Returns the Disallow rule that blocks `path` (with query), or null. */
export function matchingDisallow(rules: RobotsRule[], path: string): string | null {
  let best: RobotsRule | null = null;
  for (const r of rules) {
    if (!ruleMatches(r.path, path)) continue;
    if (
      !best ||
      r.path.length > best.path.length ||
      (r.path.length === best.path.length && r.allow && !best.allow)
    )
      best = r;
  }
  return best && !best.allow ? best.path : null;
}

export function isDisallowed(rules: RobotsRule[], path: string): boolean {
  return matchingDisallow(rules, path) !== null;
}
