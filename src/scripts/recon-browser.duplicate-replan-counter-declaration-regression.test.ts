import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Regression pin: df29db7 and ca76760 each independently added an identical
 * `let probeReplansUsed = 0; let cascadeReplansUsed = 0;` hoist to
 * recon-browser.ts. The duplicate `let` breaks esbuild's transform (the same
 * transform Vitest's Vite pipeline runs on every import of this module),
 * which made every src/scripts/recon-browser.*.test.ts file fail to load —
 * silently dropping the regression coverage those two fixes were meant to
 * add. tsc alone does not catch this: block-scoped duplicate `let` inside a
 * function is valid across sequential blocks under `--target esnext`, only
 * esbuild's stricter single-pass transform rejects it. Dynamically importing
 * recon-browser.ts here (rather than only source-scanning) forces the same
 * transform failure any other test file importing it would hit.
 */
describe("recon-browser.ts duplicate replan-budget counter declaration", () => {
  const sourcePath = path.resolve(__dirname, "recon-browser.ts");
  const source = readFileSync(sourcePath, "utf8");

  it("declares probeReplansUsed and cascadeReplansUsed exactly once each", () => {
    const probeDeclarations = source.match(/\blet\s+probeReplansUsed\b/g) ?? [];
    const cascadeDeclarations = source.match(/\blet\s+cascadeReplansUsed\b/g) ?? [];

    expect(probeDeclarations).toHaveLength(1);
    expect(cascadeDeclarations).toHaveLength(1);
  });

  it("loads/transforms cleanly (would throw esbuild's duplicate-symbol error otherwise)", async () => {
    await expect(import("@/scripts/recon-browser")).resolves.toBeDefined();
  });
});
