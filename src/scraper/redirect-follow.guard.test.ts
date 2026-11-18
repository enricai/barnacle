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
    "body-less, header-less GET probe with no credential in a header; default redirects leak no header",
  "src/testmail/client.ts":
    "body-less, header-less GET whose apikey is in the URL query string, not a header; default redirects leak no header",
  "src/lib/http.ts":
    "installs the global undici dispatcher (connect timeout only); not a request site and no redirect policy",
  "src/lib/telemetry/s3-sink.ts":
    "AWS SDK S3 client has no fetch option and never follows redirects (a 3xx surfaces as an error)",
  "src/lib/telemetry/submissions-s3-reader.ts":
    "AWS SDK S3 client has no fetch option and never follows redirects (a 3xx surfaces as an error)",
  "src/lib/telemetry/submissions-s3-objects.ts":
    "AWS SDK S3 client has no fetch option and never follows redirects (a 3xx surfaces as an error)",
};

const CTOR =
  /(?<![\w.])(?:new\s+(?:Anthropic|OpenAI)|createAnthropic|createOpenAI|createGoogleGenerativeAI|createAmazonBedrock|new\s+Browserbase|new\s+Steel|new\s+S3Client|new\s+Stagehand)\s*\(/g;
const BARE = /(?<![\w.])(?:fetch|undiciFetch)\s*\(/;
const HTTP_CLIENT =
  /(?<![\w.])(?:(?:axios|got)(?:\.(?:get|post|put|patch|delete|head|request|stream))?)\s*\(|(?<![\w])new\s+(?:undici\.)?(?:Agent|Pool|Client)\s*\(|\bhttps?\.request\s*\(/;

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\w"'`])\/\/.*$/gm, "$1");
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
    } else if (
      /\.ts$/.test(name) &&
      !/\.test\.ts$/.test(name) &&
      !name.endsWith(".d.ts")
    ) {
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

  it("every allowlist entry still contains a flagged pattern (no stale entries)", () => {
    for (const path of Object.keys(ALLOWLIST)) {
      expect(
        scanSource(readFileSync(path, "utf8")).length,
        `stale allowlist entry: ${path}`,
      ).toBeGreaterThan(0);
    }
  });

  describe("scanSource", () => {
    it("flags SDK constructors lacking a fetch option", () => {
      expect(scanSource("const c = new Anthropic({ apiKey });")).toHaveLength(
        1,
      );
      expect(scanSource("createOpenAI({ apiKey: k })")).toHaveLength(1);
      expect(scanSource("createGoogleGenerativeAI()")).toHaveLength(1);
      expect(
        scanSource("createAnthropic({ apiKey, fetch: other(1) })"),
      ).toEqual([]);
    });
    it("flags a Stagehand constructor unless a fetch option is passed", () => {
      expect(scanSource("new Stagehand({ env: 'LOCAL' })")).toHaveLength(1);
      expect(scanSource("new Stagehand({ model: { fetch: f(1) } })")).toEqual(
        [],
      );
    });
    it("flags Steel and S3 clients lacking a fetch option", () => {
      expect(scanSource("new Steel({ steelAPIKey: k })")).toHaveLength(1);
      expect(scanSource("new S3Client({ region })")).toHaveLength(1);
      expect(scanSource("new Steel({ steelAPIKey: k, fetch: f(1) })")).toEqual(
        [],
      );
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
      expect(scanSource("http.request(o)")).toHaveLength(1);
      expect(scanSource("got(u)")).toHaveLength(1);
      expect(scanSource("got.post(u)")).toHaveLength(1);
      expect(scanSource("axios(u)")).toHaveLength(1);
      expect(scanSource("new Agent({})")).toHaveLength(1);
      expect(scanSource("new undici.Pool(u)")).toHaveLength(1);
      expect(scanSource("new Client(u)")).toHaveLength(1);
      expect(scanSource("// new Anthropic({})\n/* fetch(x) */")).toEqual([]);
      expect(scanSource("x.fetch(u); undiciFetch as T")).toEqual([]);
    });
  });
});
