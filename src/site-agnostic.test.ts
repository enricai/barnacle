import { execSync } from "node:child_process";

import { describe, expect, it } from "vitest";

/**
 * Machine-enforced site-agnosticism guard. barnacle is the public engine repo and
 * must not name any real customer site or ATS vendor in tracked source. Four manual
 * audits each missed a different token because a hand-maintained list can't be proven
 * complete; this test greps the tracked tree so any reintroduction fails CI instead of
 * relying on a reviewer's memory. Extend FORBIDDEN when a new leak is found.
 */

const REPO_ROOT = `${__dirname}/..`;

/**
 * Greps TRACKED files (excluding this guard, lockfiles, and binary SVGs) and returns
 * matching `path:line:text` records. Tracked-only is deliberate: the guard gates
 * committed code (every file in a PR is tracked), and it must NOT scan untracked
 * runtime output like `.barnacle/calls.ndjson`, which legitimately contains historical
 * captured prompts. `-I` skips binary; `|| true` swallows git grep's exit-1-on-no-match
 * (the success case here).
 */
function gitGrep(flags: string, pattern: string): string[] {
  const cmd = `git grep -nI${flags} -e '${pattern}' -- ':!src/site-agnostic.test.ts' ':!pnpm-lock.yaml' ':!*.svg' || true`;
  const out = execSync(cmd, { cwd: REPO_ROOT, encoding: "utf8" });
  return out.split("\n").filter((l) => l.trim().length > 0);
}

/**
 * Tokens unique enough to match as a plain substring — a real customer site or an ATS
 * vendor/site-field prefix. None of these appear inside a legitimate English word.
 */
const FORBIDDEN_SUBSTRING = [
  "talemetry",
  "uchealth",
  "appcast",
  "phenom",
  "hhccareers",
  "encompass",
  "disneycruise",
  "getgreatcareers",
  "ggc_",
  "icims",
  "jobvite",
  "brassring",
  "successfactors",
  "smartrecruiters",
];

/**
 * Tokens that ARE substrings of legitimate words (`hca`⊂`purchase`, `lever`⊂`Verdict`,
 * `taleo`⊂…) so they must match on word boundaries only. Same substring-vs-whole-word
 * split as the manual acceptance greps — the `-w` distinction whose absence let 101
 * refs slip through a prior scrub.
 */
const FORBIDDEN_WHOLE_WORD = ["hca", "taleo", "hartford", "lever", "workday", "greenhouse"];

describe("site-agnostic: no customer-site or ATS-vendor names in tracked source", () => {
  it("has zero forbidden substring tokens", () => {
    const hits = gitGrep("iE", FORBIDDEN_SUBSTRING.join("|"));
    expect(hits, `forbidden vendor/site token(s) found:\n${hits.join("\n")}`).toEqual([]);
  });

  it("has zero forbidden whole-word tokens", () => {
    const hits = gitGrep("iwE", FORBIDDEN_WHOLE_WORD.join("|"));
    expect(hits, `forbidden vendor/site token(s) found:\n${hits.join("\n")}`).toEqual([]);
  });
});
