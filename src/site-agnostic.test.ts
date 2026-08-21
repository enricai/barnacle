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
 * `oracle hcm` is a multi-word phrase, not bare `oracle`: the bare word collides with
 * the legitimate "the browser is the oracle" testing term used in docs.
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
  "oracle hcm",
  "myworkdayjobs",
  "royalcaribbean",
  "cvshealth",
];

/**
 * Tokens that ARE substrings of legitimate words (`hca`⊂`purchase`, `lever`⊂`Verdict`,
 * `taleo`⊂…) so they must match on word boundaries only. Same substring-vs-whole-word
 * split as the manual acceptance greps — the `-w` distinction whose absence let 101
 * refs slip through a prior scrub.
 */
const FORBIDDEN_WHOLE_WORD = [
  "hca",
  "taleo",
  "hartford",
  "lever",
  "workday",
  "greenhouse",
  "cruise",
];

describe("site-agnostic: no customer-site or ATS-vendor names in tracked source", () => {
  it("has zero forbidden substring tokens", () => {
    const hits = gitGrep("iE", FORBIDDEN_SUBSTRING.join("|"));
    expect(hits, `forbidden vendor/site token(s) found:\n${hits.join("\n")}`).toEqual([]);
  });

  it("has zero forbidden whole-word tokens", () => {
    const hits = gitGrep("iwE", FORBIDDEN_WHOLE_WORD.join("|"));
    expect(hits, `forbidden vendor/site token(s) found:\n${hits.join("\n")}`).toEqual([]);
  });

  /**
   * Semantic tripwire for the class of disguised site-coupling a plain token
   * scan misses: a vendor-private DOM attribute used in CODE — as a selector
   * (`[data-automation-id=…]`), a presence match, or a `getAttribute`/
   * `hasAttribute` read. These attributes are each one ATS/widget-kit vendor's
   * signature (`data-automation-id`/`data-uxi-*` = Workday's Canvas/UXI kit,
   * `data-baseweb` = Uber Base Web, `data-phenom*` = Phenom). They are legitimate
   * ONLY inside the curated cross-vendor selector unions in
   * `src/scraper/flow-runner.ts` (`PROMPT_TRIGGER_SELECTORS` et al.), where they
   * sit alongside standard ARIA. ANY such usage in ANOTHER tracked non-test file
   * is a new one-off site hack — exactly what #178 was — and must fail CI instead
   * of a reviewer's memory. Bare prose mentions and test files are exempt.
   *
   * Matches the token in any code form (no `=` required), so `getAttribute(
   * "data-automation-id")` and `[data-baseweb]` presence selectors are caught,
   * not only `[data-automation-id='x']` literals — the gap a prior narrower
   * pattern (data-automation-id=|data-uxi=) left open.
   */
  it("uses vendor-private attribute markers only inside the curated flow-runner unions", () => {
    // `src/scraper/flow-runner.ts` is the single home of the widget-detection
    // selector unions (PROMPT_TRIGGER_SELECTORS et al., WIDGET_KIT_SELECTION_MARKER_SELECTORS,
    // + the container-resolution
    // helper that reuses them); a vendor-attr marker there is a curated union
    // member. Anywhere else — a per-site file, a new module — it is a one-off hack.
    const ALLOWED_FILE = "src/scraper/flow-runner.ts";
    const hits = gitGrep("E", "data-automation-id|data-uxi|data-baseweb|data-phenom").filter(
      (line) => {
        // git grep output is `path:lineno:text`; exempt the curated-union file and
        // test infrastructure (`*.test.ts` / `*.test-helper.ts` build fixture DOM).
        const path = line.slice(0, line.indexOf(":"));
        if (path.endsWith(".test.ts") || path.endsWith(".test-helper.ts")) return false;
        return path !== ALLOWED_FILE;
      }
    );
    expect(
      hits,
      `vendor-private attribute marker used outside the curated flow-runner selector unions:\n${hits.join("\n")}`
    ).toEqual([]);
  });
});
