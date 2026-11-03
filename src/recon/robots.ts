/**
 * Pure robots.txt parser (RFC 9309 subset): only the `User-agent: *` group is
 * honoured; Disallow/Allow use plain prefix matching, longest rule wins, and
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

/** Returns the Disallow rule that blocks `path` (with query), or null. */
export function matchingDisallow(
  rules: RobotsRule[],
  path: string,
): string | null {
  let best: RobotsRule | null = null;
  for (const r of rules) {
    if (!path.startsWith(r.path)) continue;
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
