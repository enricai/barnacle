import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Regression guard for the cookie-jar snapshot's distribution path. The
 * capture logic (src/scraper/cookie-jar.ts) and its type/dir source
 * (src/scripts/recon-shared.ts) are only reachable by a downstream consumer
 * (nursefly/autoapply) through the SAME route recon-browser itself ships by:
 * `tsc -p tsconfig.build.json` compiling all of `src/**\/*.ts` into `dist/`,
 * with no package.json `exports` subpath or `bin` entry involved — recon
 * tooling is run from a checked-out Barnacle repo via `pnpm run recon:browser`,
 * never imported as an installed package. A source-level assertion can't pin
 * this; only the compiled `dist/` output proves the module survives the real
 * build toolchain and that the emitted script still runs standalone.
 *
 * The throwaway outDir MUST be a relative path inside REPO_ROOT (not an
 * absolute os.tmpdir() path) — tsc-alias silently fails to rewrite `@/`
 * aliases when outDir resolves outside the project root, which would make
 * this test pass without exercising the real alias-rewrite path production
 * actually takes.
 */
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const TSC_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsc");
const TSC_ALIAS_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsc-alias");

describe("recon-browser — cookie-jar snapshot module reaches the built dist tree", () => {
  it("compiles cookie-jar.ts and recon-shared.ts into dist and the built recon-browser.js runs", () => {
    if (!existsSync(TSC_BIN) || !existsSync(TSC_ALIAS_BIN)) {
      throw new Error("tsc / tsc-alias not installed — cannot verify the built dist tree");
    }

    const outDirRelative = `dist-feat005-build.${process.pid}`;
    const outDir = path.join(REPO_ROOT, outDirRelative);
    // Extends the real build tsconfig so include/exclude globs and path
    // resolution match production exactly, per the recon-generate.build.test.ts
    // precedent. Lives at REPO_ROOT (not a temp dir) for the same reason.
    const tsconfigPath = path.join(REPO_ROOT, `tsconfig.feat005-build.${process.pid}.json`);
    try {
      writeFileSync(
        tsconfigPath,
        JSON.stringify({
          extends: "./tsconfig.build.json",
          compilerOptions: {
            outDir: outDirRelative,
            declaration: true,
            declarationMap: false,
          },
        })
      );

      const compile = spawnSync(TSC_BIN, ["-p", tsconfigPath], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      });
      const builtCookieJar = path.join(outDir, "scraper", "cookie-jar.js");
      const builtCookieJarTypes = path.join(outDir, "scraper", "cookie-jar.d.ts");
      const builtReconShared = path.join(outDir, "scripts", "recon-shared.js");
      const builtReconBrowser = path.join(outDir, "scripts", "recon-browser.js");
      for (const [label, filePath] of [
        ["cookie-jar.js", builtCookieJar],
        ["cookie-jar.d.ts", builtCookieJarTypes],
        ["recon-shared.js", builtReconShared],
        ["recon-browser.js", builtReconBrowser],
      ] as const) {
        if (!existsSync(filePath)) {
          throw new Error(`tsc did not emit ${label}:\n${compile.stdout}\n${compile.stderr}`);
        }
      }

      const alias = spawnSync(TSC_ALIAS_BIN, ["-p", tsconfigPath], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      });
      expect(alias.status, `${alias.stdout}\n${alias.stderr}`).toBe(0);

      // CookieRecord/CookieJarSnapshot/COOKIES_DIR are the on-disk contract a
      // downstream consumer reads — pin that the declaration file still
      // carries them post-alias-rewrite, not just pre-build in src/.
      const declaredTypes = readFileSync(path.join(outDir, "scripts", "recon-shared.d.ts"), "utf8");
      expect(declaredTypes).toContain("CookieRecord");
      expect(declaredTypes).toContain("CookieJarSnapshot");
      expect(declaredTypes).toContain("COOKIES_DIR");

      // Belt and suspenders: the built recon-browser.js still imports the
      // cookie-jar module by its post-tsc-alias relative path (not a `@/`
      // literal tsc-alias failed to rewrite), so the chain resolves at
      // runtime inside a real dist/ tree with node_modules present.
      const builtReconBrowserSource = readFileSync(builtReconBrowser, "utf8");
      expect(builtReconBrowserSource).toMatch(/require\(["']\.\.\/scraper\/cookie-jar["']\)/);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
      rmSync(tsconfigPath, { force: true });
    }
  }, 120_000);
});
