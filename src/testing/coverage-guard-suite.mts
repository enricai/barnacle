/**
 * Provides a registry-driven structural coverage guard for site plugins.
 * Mirrors the registry-first design of the loader: iterates SITE_PLUGINS (or a
 * caller-supplied stub) and asserts that each registered plugin has its required
 * co-located test file — without hardcoding any site name. Safe to run on main
 * where SITE_PLUGINS ships empty (0 iterations → trivially green); branches that
 * populate the registry gain coverage automatically.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/** Minimal plugin shape required by the guard — only `meta.siteId` is needed. */
export interface CoverageGuardPlugin {
  meta: { siteId: string };
}

export interface CoverageGuardSuiteOptions {
  /** Human-readable suite name, passed to `describe`. */
  suiteName: string;
  /**
   * Registry of plugins to guard. Pass `SITE_PLUGINS` from the loader for
   * production coverage, or a stub array in unit tests.
   */
  plugins: CoverageGuardPlugin[];
  /**
   * Absolute path to the directory that contains one sub-folder per siteId.
   * Typically `resolve(__dirname, '../sites')` from the caller's test file.
   */
  sitesDir: string;
  /**
   * Optional predicate that, when provided, is invoked once per plugin to
   * register additional `it` assertions beyond the mandatory
   * `contract.parity.test.ts` existence check. Defaults to no extra assertions.
   * The predicate receives the resolved plugin directory path and the siteId.
   */
  extraAssertions?: (pluginDir: string, siteId: string) => void;
}

/**
 * Defines a registry-driven structural coverage guard. For each plugin in
 * `opts.plugins`, registers an `it` that asserts
 * `<sitesDir>/<siteId>/contract.parity.test.ts` exists. Given an empty
 * registry, registers no assertions (always green). The optional
 * `extraAssertions` predicate allows callers to attach additional per-plugin
 * `it` blocks (e.g. integration test file or replay fixture presence) without
 * baking site-specific logic into the engine helper.
 */
export function defineCoverageGuardSuite(opts: CoverageGuardSuiteOptions): void {
  const { suiteName, plugins, sitesDir, extraAssertions } = opts;

  if (plugins.length === 0) return;

  describe(suiteName, () => {
    for (const plugin of plugins) {
      const { siteId } = plugin.meta;
      const pluginDir = resolve(sitesDir, siteId);

      it(`${siteId}: contract.parity.test.ts exists`, () => {
        expect(
          existsSync(resolve(pluginDir, "contract.parity.test.ts")),
          `${siteId}/contract.parity.test.ts must exist`
        ).toBe(true);
      });

      extraAssertions?.(pluginDir, siteId);
    }
  });
}
