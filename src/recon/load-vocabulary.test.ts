import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadReconVocabulary, VOCABULARY_NONE } from "@/recon/load-vocabulary";
import { EMPTY_VOCABULARY } from "@/recon/vocabulary";

const written: string[] = [];

/** Writes a throwaway ESM vocabulary module and returns an absolute specifier. */
function writeVocabularyModule(name: string, source: string): string {
  const path = join(tmpdir(), `barnacle-vocab-${name}-${written.length}.mjs`);
  writeFileSync(path, source);
  written.push(path);
  return path;
}

afterEach(() => {
  for (const p of written.splice(0)) {
    try {
      unlinkSync(p);
    } catch {
      // best effort — tmp files are disposable
    }
  }
});

describe("loadReconVocabulary — stateful regex rejection", () => {
  /**
   * The g flag makes .test() advance lastIndex, so a pattern matched against many
   * instructions returns false on alternate calls. In `exclusions` that is a PII
   * leak: /signature/gi stops excluding every other step and the applicant's name
   * splices into a signature field. Fail closed rather than emit a plugin whose
   * splices depend on step order.
   */
  it("rejects a g-flagged exclusion", async () => {
    const spec = writeVocabularyModule(
      "g-exclusion",
      `export const vocabulary = { subject: /x/i, exclusions: [/signature/gi], table: [] };`
    );
    await expect(loadReconVocabulary(spec, process.cwd())).rejects.toThrow(/g or y flag/);
  });

  it("rejects a y-flagged table regex", async () => {
    const spec = writeVocabularyModule(
      "y-table",
      `export const vocabulary = { subject: /x/i, exclusions: [], table: [[/\\bcity\\b/y, "City"]] };`
    );
    await expect(loadReconVocabulary(spec, process.cwd())).rejects.toThrow(/g or y flag/);
  });

  it("rejects a g-flagged subject", async () => {
    const spec = writeVocabularyModule(
      "g-subject",
      `export const vocabulary = { subject: /candidate/g, exclusions: [], table: [] };`
    );
    await expect(loadReconVocabulary(spec, process.cwd())).rejects.toThrow(/g or y flag/);
  });

  it("accepts the equivalent stateless flags", async () => {
    const spec = writeVocabularyModule(
      "stateless",
      `export const vocabulary = { subject: /candidate/i, exclusions: [/signature/i], table: [[/\\bcity\\b/i, "City"]] };`
    );
    const v = await loadReconVocabulary(spec, process.cwd());
    expect(v.table[0]?.[1]).toBe("City");
  });
});

describe("loadReconVocabulary — payload field names must be identifiers", () => {
  /** A field name is spliced verbatim into `payload.<name>` and
   * `{{ .request.<name> }}`; a non-identifier emits a plugin that is broken but
   * still generates, which is the silent-failure shape this loader exists to stop. */
  it("rejects a field name that is not a JS identifier", async () => {
    const spec = writeVocabularyModule(
      "bad-ident",
      `export const vocabulary = { subject: /x/i, exclusions: [], table: [[/\\bfirst name\\b/i, "not a valid ident!"]] };`
    );
    await expect(loadReconVocabulary(spec, process.cwd())).rejects.toThrow(/valid JS identifier/);
  });

  it("rejects a field name starting with a digit", async () => {
    const spec = writeVocabularyModule(
      "digit-ident",
      `export const vocabulary = { subject: /x/i, exclusions: [], table: [[/\\bx\\b/i, "1Field"]] };`
    );
    await expect(loadReconVocabulary(spec, process.cwd())).rejects.toThrow(/valid JS identifier/);
  });
});

describe("loadReconVocabulary — export resolution", () => {
  it("returns EMPTY_VOCABULARY for the none sentinel without touching disk", async () => {
    expect(await loadReconVocabulary(VOCABULARY_NONE, process.cwd())).toBe(EMPTY_VOCABULARY);
  });

  it("accepts a default export", async () => {
    const spec = writeVocabularyModule(
      "default-export",
      `export default { subject: /candidate/i, exclusions: [], table: [[/\\bcity\\b/i, "City"]] };`
    );
    const v = await loadReconVocabulary(spec, process.cwd());
    expect(v.table[0]?.[1]).toBe("City");
  });

  it("throws naming the specifier when the module exports no vocabulary", async () => {
    const spec = writeVocabularyModule("empty", `export const somethingElse = 1;`);
    await expect(loadReconVocabulary(spec, process.cwd())).rejects.toThrow(
      /does not export a valid/
    );
  });
});
