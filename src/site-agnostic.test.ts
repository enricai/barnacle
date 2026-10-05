import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// This repo is site agnostic: no plugin/site vocabulary may appear
// anywhere under src/ — not in code, comments, test fixtures, or FILE
// NAMES. Two prior scrubs (#149, #150 — the second fixing "15 files
// missed by whole-word grep") removed these names, and they returned
// within weeks because nothing guarded them; this test's predecessor
// was deleted in 847208b. The names recur mostly via automated fix runs
// that mirror a bug report's vocabulary into fixtures and comments —
// this guard turns that into an immediate local test failure instead of
// a cross-run convergence blocker.
//
// Adding a term: lowercase, no separators (the scan lowercases and
// checks substrings, so "partyMix", "party_mix", and "PARTYMIX" all
// hit "partymix").
const FORBIDDEN = [
  "disney",
  "cruise",
  "royalcaribbean",
  "piedmont",
  "partymix",
  "sailmonth",
  "privateisland",
];

const REPO_ROOT = path.resolve(__dirname, "..");
const SELF = path.relative(REPO_ROOT, __filename).replace(/\\/g, "/");

function trackedSourceFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "src"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return out.split("\n").filter((f) => f && !f.endsWith(`/${path.basename(SELF)}`) && f !== SELF);
}

describe("site-agnostic guard", () => {
  it("no forbidden site vocabulary in src/ contents or file names", () => {
    const violations: string[] = [];
    for (const file of trackedSourceFiles()) {
      const lowerName = file.toLowerCase();
      for (const term of FORBIDDEN) {
        if (lowerName.includes(term)) {
          violations.push(`${file} (file NAME contains "${term}")`);
        }
      }
      let text: string;
      try {
        text = readFileSync(path.join(REPO_ROOT, file), "utf8");
      } catch {
        continue; // binary or unreadable — names are the risk, not bytes
      }
      const lines = text.split("\n");
      lines.forEach((line, i) => {
        const lower = line.toLowerCase();
        for (const term of FORBIDDEN) {
          if (lower.includes(term)) {
            violations.push(`${file}:${i + 1} contains "${term}": ${line.trim().slice(0, 120)}`);
          }
        }
      });
    }
    expect(
      violations,
      `site vocabulary found — this repo is site agnostic; use synthetic ` +
        `domain terms in fixtures and examples:\n  ${violations.join("\n  ")}`
    ).toEqual([]);
  });
});
