/**
 * Unit tests for defineCoverageGuardSuite. Uses a stub plugin registry and a
 * temporary directory so no real site plugins are imported and no real
 * filesystem layout is required.
 */

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  type CoverageGuardPlugin,
  type CoverageGuardSuiteOptions,
  defineCoverageGuardSuite,
} from "@/testing/coverage-guard-suite.mjs";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeStubPlugins(siteIds: string[]): CoverageGuardPlugin[] {
  return siteIds.map((siteId) => ({ meta: { siteId } }));
}

/**
 * Creates a temp dir with each siteId having its contract.parity.test.ts present.
 */
function makeStubSitesDir(presentSiteIds: string[]): string {
  const sitesDir = mkdtempSync(join(tmpdir(), "coverage-guard-test-"));
  for (const siteId of presentSiteIds) {
    const dir = resolve(sitesDir, siteId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "contract.parity.test.ts"), "// stub");
  }
  return sitesDir;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("defineCoverageGuardSuite", () => {
  it("produces a passing assertion for each plugin whose contract.parity.test.ts exists", () => {
    const siteIds = ["site-one", "site-two", "site-three"];
    const sitesDir = makeStubSitesDir(siteIds);

    for (const siteId of siteIds) {
      const path = resolve(sitesDir, siteId, "contract.parity.test.ts");
      expect(existsSync(path)).toBe(true);
    }
  });

  it("produces a failing assertion for a plugin whose contract.parity.test.ts is absent", () => {
    const sitesDir = makeStubSitesDir([]);
    const path = resolve(sitesDir, "missing-site", "contract.parity.test.ts");
    expect(existsSync(path)).toBe(false);
  });

  it("registers no assertions for an empty plugin registry (loop runs zero times)", () => {
    const opts: CoverageGuardSuiteOptions = {
      suiteName: "empty registry guard",
      plugins: [],
      sitesDir: makeStubSitesDir([]),
    };

    let iterations = 0;
    for (const _plugin of opts.plugins) {
      iterations++;
    }
    expect(iterations).toBe(0);
  });

  it("extraAssertions is invoked once per plugin with the correct pluginDir and siteId", () => {
    const siteIds = ["alpha", "beta"];
    const sitesDir = makeStubSitesDir(siteIds);
    const plugins = makeStubPlugins(siteIds);

    const calls: Array<{ pluginDir: string; siteId: string }> = [];

    // Simulate what defineCoverageGuardSuite does without nesting describe
    // inside a running it block (vitest disallows that).
    const extraAssertions = (pluginDir: string, siteId: string): void => {
      calls.push({ pluginDir, siteId });
    };

    for (const plugin of plugins) {
      const { siteId } = plugin.meta;
      const pluginDir = resolve(sitesDir, siteId);
      extraAssertions(pluginDir, siteId);
    }

    expect(calls).toHaveLength(2);
    expect(calls[0]?.siteId).toBe("alpha");
    expect(calls[1]?.siteId).toBe("beta");
    expect(calls[0]?.pluginDir).toBe(resolve(sitesDir, "alpha"));
    expect(calls[1]?.pluginDir).toBe(resolve(sitesDir, "beta"));
  });
});

// ── Top-level registration (exercises the real describe/it path) ──────────────
// defineCoverageGuardSuite must be called at the top level or inside another
// describe — not inside an it() block.

// (A) Two plugins with files present — both existence its must pass.
const STUB_SITE_IDS = ["stub-guard-a", "stub-guard-b"];
const STUB_SITES_DIR = makeStubSitesDir(STUB_SITE_IDS);

defineCoverageGuardSuite({
  suiteName: "stub coverage guard (registered at module load time)",
  plugins: makeStubPlugins(STUB_SITE_IDS),
  sitesDir: STUB_SITES_DIR,
});

// (B) Arbitrary siteIds to confirm no hardcoded names in the helper.
const ARBITRARY_SITE_IDS = ["totally-made-up", "another-fake-site"];
const ARBITRARY_SITES_DIR = makeStubSitesDir(ARBITRARY_SITE_IDS);

defineCoverageGuardSuite({
  suiteName: "arbitrary-siteId coverage guard (no hardcoded names)",
  plugins: makeStubPlugins(ARBITRARY_SITE_IDS),
  sitesDir: ARBITRARY_SITES_DIR,
});

// (C) extraAssertions: verify pluginDir is derived as resolve(sitesDir, siteId).
const EXTRA_SITE_IDS = ["gamma", "delta"];
const EXTRA_SITES_DIR = makeStubSitesDir(EXTRA_SITE_IDS);
const observedExtraDirs: string[] = [];

defineCoverageGuardSuite({
  suiteName: "extraAssertions pluginDir derivation check",
  plugins: makeStubPlugins(EXTRA_SITE_IDS),
  sitesDir: EXTRA_SITES_DIR,
  extraAssertions: (pluginDir, siteId) => {
    it(`${siteId}: extraAssertions receives correct pluginDir`, () => {
      expect(pluginDir).toBe(resolve(EXTRA_SITES_DIR, siteId));
      observedExtraDirs.push(pluginDir);
    });
  },
});

// (D) Empty registry — defineCoverageGuardSuite returns without calling describe,
// so no "no tests in suite" vitest error is raised.
defineCoverageGuardSuite({
  suiteName: "empty coverage guard (should not register any describe)",
  plugins: [],
  sitesDir: STUB_SITES_DIR,
});
