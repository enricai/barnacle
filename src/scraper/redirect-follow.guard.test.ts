import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Single redirect-policy guard. Outbound requests must obey one redirect rule:
 * they go through the method-preserving follower. In non-test src this flags
 *   - bare `fetch(` / `undiciFetch(` calls, and
 *   - SDK / HTTP client constructions (new Anthropic, new OpenAI,
 *     createAnthropic, createOpenAI, createGoogleGenerativeAI, axios/got
 *     calls, undici Agent/Pool/Client, node http/https request) whose options
 *     do not pass a `fetch` option.
 * Allowlisted files (path -> reason) are exempt.
 * Example of a flagged call: `fetch("https://example.com/x")`.
 */
const ALLOWLIST: Record<string, string> = {
  "src/scripts/recon-http.ts":
    "robots.txt probe is a body-less GET where a canonical-host redirect is desired; no credentials sent",
  "src/testmail/client.ts": "testmail probe is a body-less GET; no method/body to preserve",
  "src/scraper/raw-fetch.ts":
    "explicit redirect:manual path that hands redirects to the follower itself",
  "src/lib/http.ts":
    "installs the global undici dispatcher (connect timeout only); not a request site and no redirect policy",
  "src/scraper/redirect-follow.ts": "the follower itself; the one place that calls fetch",
};

const CTOR =
  /(?<![\w.])(?:new\s+(?:Anthropic|OpenAI)|createAnthropic|createOpenAI|createGoogleGenerativeAI)\s*\(/g;
const BARE = /(?<![\w.])(?:fetch|undiciFetch)\s*\(/;
const HTTP_CLIENT =
  /(?<![\w.])(?:(?:axios|got)(?:\.(?:get|post|put|patch|delete|head|request|stream))?)\s*\(|(?<![\w])new\s+(?:undici\.)?(?:Agent|Pool|Client)\s*\(|\bhttps?\.request\s*\(/;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\w"'`])\/\/.*$/gm, "$1");
}

/** Body of the balanced parens starting at index of "(" in s. */
function argsAt(s: string, open: number): string {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) return s.slice(open + 1, i);
  }
  return s.slice(open + 1);
}

/** Returns human-readable violations found in a source string. */
function scanSource(source: string): string[] {
  const src = stripComments(source);
  const out: string[] = [];
  if (BARE.test(src)) out.push("bare fetch(");
  if (HTTP_CLIENT.test(src)) out.push("raw HTTP client without follower");
  for (const m of src.matchAll(CTOR)) {
    const args = argsAt(src, m.index + m[0].length - 1);
    if (!/(^|[\s,{])fetch\s*[:,}]|(^|[\s,{])fetch\s*$/.test(args)) {
      out.push(`${m[0].replace(/\s+/g, " ")} without fetch option`);
    }
  }
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "node_modules") walk(p, out);
    } else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name) && !name.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

describe("redirect-policy guard", () => {
  it("only allowlisted files make requests without the follower", () => {
    const offenders: Record<string, string[]> = {};
    for (const file of walk("src")) {
      const rel = relative(".", file).split("\\").join("/");
      if (rel in ALLOWLIST) continue;
      const v = scanSource(readFileSync(file, "utf8"));
      if (v.length) offenders[rel] = v;
    }
    expect(offenders).toEqual({});
  });

  it("every allowlist entry has a reason and exists", () => {
    for (const [path, reason] of Object.entries(ALLOWLIST)) {
      expect(reason.length, path).toBeGreaterThan(10);
      expect(() => statSync(path), path).not.toThrow();
    }
  });

  describe("scanSource", () => {
    it("flags SDK constructors lacking a fetch option", () => {
      expect(scanSource("const c = new Anthropic({ apiKey });")).toHaveLength(1);
      expect(scanSource("createOpenAI({ apiKey: k })")).toHaveLength(1);
      expect(scanSource("createGoogleGenerativeAI()")).toHaveLength(1);
      expect(scanSource("createAnthropic({ apiKey, fetch: other(1) })")).toEqual([]);
    });
    it("passes constructors that pass fetch", () => {
      expect(scanSource("new Anthropic({ apiKey, fetch: f(1) })")).toEqual([]);
      expect(scanSource("new OpenAI({ apiKey, fetch })")).toEqual([]);
    });
    it("flags bare fetch and HTTP clients, ignores comments", () => {
      expect(scanSource("await fetch('https://example.com')")).toHaveLength(1);
      expect(scanSource("undiciFetch(u)")).toHaveLength(1);
      expect(scanSource("axios.get(u)")).toHaveLength(1);
      expect(scanSource("https.request(o)")).toHaveLength(1);
      expect(scanSource("// new Anthropic({})\n/* fetch(x) */")).toEqual([]);
      expect(scanSource("x.fetch(u); undiciFetch as T")).toEqual([]);
    });
  });
});
