import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Gap G's regression guard, and it MUST run against the BUILT artifact, not the
 * emitter source. The bug it pins is invisible in `src/`: the emitter correctly
 * writes `@enricai/barnacle/<subpath>` template literals, but the failure mode
 * was `@/` literals that `tsc-alias` rewrote to broken `../` relative paths
 * *inside the template string* at build time. A source-level assertion passes
 * today and proves nothing — only the post-`tsc-alias` output can regress.
 *
 * So this test runs the real `tsc` + `tsc-alias` toolchain into a throwaway
 * outDir (never touching the shipped `dist/`) and greps the compiled emitter for
 * `from "../` — the exact signature of an engine import that tsc-alias mangled.
 */
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const TSC_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsc");
const TSC_ALIAS_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsc-alias");

describe("recon-generate — built dist emitter carries no tsc-alias-mangled imports", () => {
  it('has zero `from "../` engine imports after tsc + tsc-alias', () => {
    if (!existsSync(TSC_BIN) || !existsSync(TSC_ALIAS_BIN)) {
      throw new Error("tsc / tsc-alias not installed — cannot verify the built emitter");
    }

    const outDir = mkdtempSync(path.join(os.tmpdir(), "barnacle-gapg-build-"));
    // The tsconfig must live at REPO_ROOT so its `include`/`exclude` globs and
    // `@types/node` resolution behave exactly as the real build — a tsconfig in
    // a temp dir resolves those relative to itself and mis-compiles. Uniquely
    // named and removed in `finally` so it never collides with the real config.
    const tsconfigPath = path.join(REPO_ROOT, `tsconfig.gapg-build.${process.pid}.json`);
    try {
      writeFileSync(
        tsconfigPath,
        JSON.stringify({
          extends: "./tsconfig.build.json",
          compilerOptions: {
            outDir: path.join(outDir, "dist"),
            declaration: false,
            declarationMap: false,
          },
        })
      );

      const compile = spawnSync(TSC_BIN, ["-p", tsconfigPath], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      });
      // tsc may surface unrelated diagnostics; the artifact is what matters, so
      // we only fail if the emitter file itself was not produced.
      const builtEmitter = path.join(outDir, "dist", "scripts", "recon-generate.js");
      if (!existsSync(builtEmitter)) {
        throw new Error(
          `tsc did not emit recon-generate.js:\n${compile.stdout}\n${compile.stderr}`
        );
      }

      const alias = spawnSync(TSC_ALIAS_BIN, ["-p", tsconfigPath], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      });
      expect(alias.status, `${alias.stdout}\n${alias.stderr}`).toBe(0);

      const built = readFileSync(builtEmitter, "utf8");
      const mangledEngineImports = Array.from(
        built.matchAll(/from "(\.\.\/[^"]+)"/g),
        (m) => m[1] as string
      );
      expect(mangledEngineImports).toEqual([]);

      // And the fix's positive side: engine imports are emitted through the
      // bare-specifier ENGINE_PKG constant, which tsc-alias leaves untouched
      // (it is not an `@/` alias), so they resolve out-of-tree. The runtime
      // interpolation means the compiled artifact carries the template form.
      expect(built).toContain(["$", "{ENGINE_PKG}/scraper/session"].join(""));
      // Belt and suspenders: the literal package name is still present as the
      // ENGINE_PKG value, so the interpolation actually produces the subpath.
      expect(built).toContain('ENGINE_PKG = "@enricai/barnacle"');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
      rmSync(tsconfigPath, { force: true });
    }
  }, 120_000);
});
