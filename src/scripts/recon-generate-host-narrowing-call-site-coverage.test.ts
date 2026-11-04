import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE_PATH = path.join(__dirname, "recon-generate.ts");
const SOURCE = readFileSync(SOURCE_PATH, "utf8");

/**
 * Functions whose `isAllowedFixtureHost` call must be narrowed by a
 * `primaryHost` parameter -- the exact set the report identified after two
 * prior PRs each patched only a subset of them.
 */
const NARROWED_CALL_SITES = [
  "isGraphQL",
  "firstGraphQLCapture",
  "selectPrimaryGraphQLOperation",
  "firstEndpointCapture",
  "extractActionSequence",
  "extractGraphQLActionSequence",
] as const;

/**
 * Call sites that legitimately do not thread `primaryHost` as a parameter,
 * mapped to the number of calls each is expected to make: `deriveBaseUrl`
 * runs before `primaryHost` exists (it's what derives the base URL
 * `primaryHost` is later read from), and `main` passes the freshly-derived
 * `primaryHost` local directly at each of its own call sites rather than
 * receiving it as a parameter.
 */
const EXEMPT_CALL_SITES = { deriveBaseUrl: 1, main: 2 } as const;

const EXEMPT_CALL_SITE_NAMES = Object.keys(EXEMPT_CALL_SITES) as (keyof typeof EXEMPT_CALL_SITES)[];

const EXEMPT_CALL_COUNT = Object.values(EXEMPT_CALL_SITES).reduce((sum, n) => sum + n, 0);

/** Extracts a `function name(...) { ... }` declaration's full text via brace matching. */
function extractFunctionSource(source: string, functionName: string): string {
  const declMatch = source.match(
    new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${functionName}\\s*\\(`)
  );
  if (declMatch === null || declMatch.index === undefined) {
    throw new Error(`could not locate declaration of ${functionName}`);
  }
  const bodyStart = source.indexOf("{", declMatch.index);
  if (bodyStart === -1) {
    throw new Error(`could not locate body opening brace of ${functionName}`);
  }
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(declMatch.index, i + 1);
    }
  }
  throw new Error(`unbalanced braces while extracting ${functionName}`);
}

describe("recon-generate.ts isAllowedFixtureHost call-site coverage", () => {
  it("asserts the exact total number of isAllowedFixtureHost call sites", () => {
    const callCount = (SOURCE.match(/isAllowedFixtureHost\(/g) ?? []).length;
    // one call site per narrowed function + the per-function expected counts
    // of the exempt ones -- a new, unaccounted-for call site changes this
    // count and fails the test.
    expect(callCount).toBe(NARROWED_CALL_SITES.length + EXEMPT_CALL_COUNT);
  });

  it.each(NARROWED_CALL_SITES)(
    "%s calls isAllowedFixtureHost and declares primaryHost in its parameter list",
    (functionName) => {
      const functionSource = extractFunctionSource(SOURCE, functionName);
      const paramListEnd = functionSource.indexOf("{");
      const paramList = functionSource.slice(0, paramListEnd);
      expect(functionSource).toContain("isAllowedFixtureHost(");
      expect(paramList).toMatch(/\bprimaryHost\s*:/);
    }
  );

  it.each(EXEMPT_CALL_SITE_NAMES)(
    "%s is a documented exception and is not required to declare primaryHost as a parameter",
    (functionName) => {
      const functionSource = extractFunctionSource(SOURCE, functionName);
      const calls = (functionSource.match(/isAllowedFixtureHost\(/g) ?? []).length;
      expect(calls).toBe(EXEMPT_CALL_SITES[functionName]);
    }
  );
});
