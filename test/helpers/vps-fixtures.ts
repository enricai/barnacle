import { readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURE_DIR = join(process.cwd(), "test", "fixtures", "vps");

/**
 * Map of VPS endpoint slug → source fixture filename shipped by RC.
 */
export const VPS_FIXTURES = {
  "sailing-package": "Sample Sailing Package Request and Response.json",
  "sailing-package-changes": "Sample Sailing Package Changes Request and Response.json",
  "super-category-pricing": "Sample Super Category Pricing Request and Response.json",
  "category-pricing": "Sample Category Pricing Request and Response.json",
  "group-pricing": "Sample Group Pricing Request and Response.json",
  "price-changes-super-category":
    "Sample Price Change Identification - Super Category Request and Response.json",
  "price-changes-category":
    "Sample Price Change Identification - Category Request and Response.json",
  "promotion-details": "Sample Promotion Details Request and Response.json",
} as const;

export type VpsFixtureKey = keyof typeof VPS_FIXTURES;

/**
 * A single fixture parsed into request + response JSON object arrays.
 */
export interface VpsFixture {
  responses: unknown[];
}

/**
 * Strips `//` line comments (but leaves `://` in URLs untouched) from a
 * fixture file. The RC samples use `//` at the start of logical lines only,
 * so this is safe.
 */
function stripLineComments(src: string): string {
  return src
    .split("\n")
    .map((line) => {
      const commentStart = line.indexOf("//");
      if (commentStart === -1) return line;
      // keep `http://` / `https://` etc by checking if `://` appears
      const before = line.slice(0, commentStart);
      if (/[a-zA-Z]$/.test(before.trimEnd()) && line[commentStart + 2] === "/") {
        return line;
      }
      return before;
    })
    .join("\n");
}

/**
 * Extracts balanced JSON objects from a string. Walks characters keeping
 * track of brace depth, ignoring braces inside string literals. Returns each
 * top-level `{...}` block as its own substring.
 */
function extractJsonObjects(src: string): string[] {
  const out: string[] = [];
  const chars = Array.from(src);
  const len = chars.length;
  const pushBlock = (start: number, end: number): void => {
    const block = src.slice(start, end + 1);
    out.push(block);
  };
  const openEntry = { value: -1 };
  const depthEntry = { value: 0 };
  const inStringEntry = { value: false };
  const escapeEntry = { value: false };
  for (const [i, ch] of chars.entries()) {
    if (inStringEntry.value) {
      if (escapeEntry.value) {
        escapeEntry.value = false;
      } else if (ch === "\\") {
        escapeEntry.value = true;
      } else if (ch === '"') {
        inStringEntry.value = false;
      }
      continue;
    }
    if (ch === '"') {
      inStringEntry.value = true;
      continue;
    }
    if (ch === "{") {
      if (depthEntry.value === 0) openEntry.value = i;
      depthEntry.value += 1;
      continue;
    }
    if (ch === "}") {
      depthEntry.value -= 1;
      if (depthEntry.value === 0 && openEntry.value !== -1) {
        pushBlock(openEntry.value, i);
        openEntry.value = -1;
      }
    }
    if (i === len - 1 && depthEntry.value !== 0) {
      throw new Error("unbalanced braces in fixture");
    }
  }
  return out;
}

/**
 * Loads a VPS fixture by key and returns every parseable top-level response
 * object found in it. Some fixture files contain multiple response variants
 * (e.g. "Request by Client" + "Request by Market"); all are returned.
 */
export function loadVpsFixture(key: VpsFixtureKey): VpsFixture {
  const filename = VPS_FIXTURES[key];
  const raw = readFileSync(join(FIXTURE_DIR, filename), "utf-8");
  const stripped = stripLineComments(raw);
  const blocks = extractJsonObjects(stripped);
  const responses = blocks
    .map((block): unknown => {
      try {
        return JSON.parse(block);
      } catch {
        return undefined;
      }
    })
    .filter((parsed): parsed is Record<string, unknown> => {
      if (typeof parsed !== "object" || parsed === null) return false;
      const obj = parsed as Record<string, unknown>;
      return "status" in obj && typeof obj.status === "object";
    });
  return { responses };
}
