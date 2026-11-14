import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Guard: non-test source must not call bare `fetch(` (or undici fetch) directly.
 * Every outbound request goes through the method-preserving follower, except
 * the allowlisted sites below, each with a stated reason.
 */
const ALLOWLIST: Record<string, string> = {
  "src/scripts/recon-http.ts":
    "robots.txt probe is a body-less plain GET; following a canonical-host redirect is desirable",
  "src/testmail/client.ts": "testmail probe is a body-less GET; no method/body to preserve",
  "src/scraper/raw-fetch.ts":
    "explicit redirect:manual path that hands redirects to the follower itself",
  "src/scraper/redirect-follow.ts": "the follower itself; the one place that calls fetch",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
  }
  return out;
}

describe("bare fetch guard", () => {
  it("only allowlisted files call bare fetch(", () => {
    const offenders: string[] = [];
    for (const file of walk("src")) {
      const rel = relative(".", file).split("\\").join("/");
      if (rel in ALLOWLIST) continue;
      const src = readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
        .join("\n");
      if (/(?<![\w.])(fetch|undiciFetch)\s*\(/.test(src)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("every allowlist entry has a reason and exists", () => {
    for (const [path, reason] of Object.entries(ALLOWLIST)) {
      expect(reason.length).toBeGreaterThan(10);
      expect(() => statSync(path)).not.toThrow();
    }
  });
});
