import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import type { AppConfig } from "@/config";
import {
  BUILTIN_SITE_PLUGINS,
  loadAllPlugins,
  loadPlugins,
  type PluginLoadRecord,
  resolvePluginSpecifier,
} from "@/plugins/discover";

// Absolute paths to fixture files under src/plugins/__fixtures__/
const FIXTURES_DIR = path.join(__dirname, "__fixtures__");
const FIXTURE = {
  validDefault: path.join(FIXTURES_DIR, "valid-default-export.js"),
  validNamed: path.join(FIXTURES_DIR, "valid-plugin-named-export.js"),
  malformedNoMeta: path.join(FIXTURES_DIR, "malformed-no-meta.js"),
  malformedExecuteNotFn: path.join(FIXTURES_DIR, "malformed-execute-not-fn.js"),
  malformedBodySchema: path.join(FIXTURES_DIR, "malformed-bodyschema-not-zod.js"),
  apiVersionMismatch: path.join(FIXTURES_DIR, "apiversion-mismatch.js"),
  duplicateSiteId: path.join(FIXTURES_DIR, "duplicate-siteid.js"),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns a fresh empty `seenSiteIds` set for each test. */
function freshSeen(...preseeded: string[]): Set<string> {
  return new Set(preseeded);
}

/** Minimal AppConfig stub for `loadAllPlugins`. */
function makeConfig(overrides?: Partial<AppConfig["plugins"]>): AppConfig {
  return {
    plugins: {
      specifiers: [],
      strict: false,
      baseDir: process.cwd(),
      ...overrides,
    },
  } as unknown as AppConfig;
}

// ---------------------------------------------------------------------------
// resolvePluginSpecifier
// ---------------------------------------------------------------------------

describe("resolvePluginSpecifier", () => {
  it("resolves a relative path to an absolute file:// URL", () => {
    const baseDir = FIXTURES_DIR;
    const result = resolvePluginSpecifier("./valid-default-export.js", baseDir);
    expect(result).toBe(pathToFileURL(FIXTURE.validDefault).href);
  });

  it("passes an absolute path through as a file:// URL", () => {
    const result = resolvePluginSpecifier(FIXTURE.validDefault, process.cwd());
    expect(result).toBe(pathToFileURL(FIXTURE.validDefault).href);
  });

  it("resolves a package name via the baseDir's node_modules", () => {
    // "zod" is installed in this project's node_modules — use it as a real package fixture.
    const baseDir = process.cwd();
    const result = resolvePluginSpecifier("zod/v4", baseDir);
    expect(result).toMatch(/^file:\/\//);
    expect(result).toContain("zod");
  });

  it("throws with specifier and baseDir in the message when unresolvable", () => {
    const baseDir = process.cwd();
    expect(() => resolvePluginSpecifier("@nonexistent/barnacle-plugin-xyz", baseDir)).toThrow(
      "@nonexistent/barnacle-plugin-xyz"
    );
    expect(() => resolvePluginSpecifier("@nonexistent/barnacle-plugin-xyz", baseDir)).toThrow(
      baseDir
    );
  });
});

// ---------------------------------------------------------------------------
// loadPlugins
// ---------------------------------------------------------------------------

describe("loadPlugins — valid default export", () => {
  it("produces a loaded record for a valid default-export plugin", async () => {
    const { plugins, report } = await loadPlugins([FIXTURE.validDefault], {
      baseDir: process.cwd(),
      strict: false,
      seenSiteIds: freshSeen(),
    });

    expect(plugins).toHaveLength(1);
    expect(report).toHaveLength(1);

    const rec = report[0] as PluginLoadRecord;
    expect(rec.status).toBe("loaded");
    expect(rec.siteId).toBe("fixture-valid");
    expect(rec.displayName).toBe("Fixture Valid Plugin");
    expect(rec.route).toBe("/v1/fixture-valid/run");
  });
});

describe("loadPlugins — named { plugin } export normalization", () => {
  it("normalizes a { plugin } export and produces a loaded record", async () => {
    const { plugins, report } = await loadPlugins([FIXTURE.validNamed], {
      baseDir: process.cwd(),
      strict: false,
      seenSiteIds: freshSeen(),
    });

    expect(plugins).toHaveLength(1);
    expect(report[0]?.status).toBe("loaded");
    expect(report[0]?.siteId).toBe("fixture-named");
  });
});

describe("loadPlugins — malformed fixtures in non-strict mode", () => {
  const MALFORMED: Array<{ name: string; fixturePath: string }> = [
    { name: "missing meta", fixturePath: FIXTURE.malformedNoMeta },
    { name: "execute not a function", fixturePath: FIXTURE.malformedExecuteNotFn },
    { name: "bodySchema not a Zod schema", fixturePath: FIXTURE.malformedBodySchema },
  ];

  for (const { name, fixturePath } of MALFORMED) {
    it(`produces a disabled record (non-strict) for: ${name}`, async () => {
      const { plugins, report } = await loadPlugins([fixturePath], {
        baseDir: process.cwd(),
        strict: false,
        seenSiteIds: freshSeen(),
      });

      expect(plugins).toHaveLength(0);
      expect(report).toHaveLength(1);
      expect(report[0]?.status).toBe("disabled");
      expect(report[0]?.reason).toBeTruthy();
    });
  }
});

describe("loadPlugins — malformed fixtures in strict mode", () => {
  const MALFORMED: Array<{ name: string; fixturePath: string }> = [
    { name: "missing meta", fixturePath: FIXTURE.malformedNoMeta },
    { name: "execute not a function", fixturePath: FIXTURE.malformedExecuteNotFn },
    { name: "bodySchema not a Zod schema", fixturePath: FIXTURE.malformedBodySchema },
  ];

  for (const { name, fixturePath } of MALFORMED) {
    it(`throws in strict mode for: ${name}`, async () => {
      await expect(
        loadPlugins([fixturePath], {
          baseDir: process.cwd(),
          strict: true,
          seenSiteIds: freshSeen(),
        })
      ).rejects.toThrow();
    });
  }
});

describe("loadPlugins — apiVersion major mismatch", () => {
  it("disables a plugin whose apiVersion major differs from core", async () => {
    const { plugins, report } = await loadPlugins([FIXTURE.apiVersionMismatch], {
      baseDir: process.cwd(),
      strict: false,
      seenSiteIds: freshSeen(),
    });

    expect(plugins).toHaveLength(0);
    expect(report[0]?.status).toBe("disabled");
    expect(report[0]?.reason).toMatch(/incompatible/i);
  });
});

describe("loadPlugins — duplicate siteId across specifiers", () => {
  it("disables the second plugin with a duplicate siteId", async () => {
    const specifiers = [FIXTURE.validDefault, FIXTURE.duplicateSiteId];
    const { plugins, report } = await loadPlugins(specifiers, {
      baseDir: process.cwd(),
      strict: false,
      seenSiteIds: freshSeen(),
    });

    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.meta.siteId).toBe("fixture-valid");

    expect(report).toHaveLength(2);
    expect(report[0]?.status).toBe("loaded");
    expect(report[1]?.status).toBe("disabled");
    expect(report[1]?.reason).toMatch(/duplicate/i);
  });
});

describe("loadPlugins — out-of-tree plugin collides with seeded built-in siteId", () => {
  it("disables the out-of-tree plugin when its siteId is already in seenSiteIds", async () => {
    // Pre-seed "fixture-valid" as if it were a built-in.
    const { plugins, report } = await loadPlugins([FIXTURE.validDefault], {
      baseDir: process.cwd(),
      strict: false,
      seenSiteIds: freshSeen("fixture-valid"),
    });

    expect(plugins).toHaveLength(0);
    expect(report[0]?.status).toBe("disabled");
    expect(report[0]?.reason).toMatch(/duplicate/i);
  });
});

// ---------------------------------------------------------------------------
// loadAllPlugins
// ---------------------------------------------------------------------------

describe("loadAllPlugins", () => {
  it("returns an empty plugins array and empty report when no specifiers and no built-ins", async () => {
    const { plugins, report } = await loadAllPlugins(makeConfig());
    // BUILTIN_SITE_PLUGINS is empty (no in-tree sites).
    expect(plugins).toHaveLength(BUILTIN_SITE_PLUGINS.length);
    expect(report).toHaveLength(BUILTIN_SITE_PLUGINS.length);
  });

  it("lists built-ins first, out-of-tree plugins appended", async () => {
    const { plugins, report } = await loadAllPlugins(
      makeConfig({ specifiers: [FIXTURE.validDefault] })
    );

    // Built-ins (0 in this repo) come first; then the out-of-tree plugin.
    const outOfTreeIdx = report.findIndex((r) => r.siteId === "fixture-valid");
    expect(outOfTreeIdx).toBe(BUILTIN_SITE_PLUGINS.length);
    expect(plugins[BUILTIN_SITE_PLUGINS.length]?.meta.siteId).toBe("fixture-valid");
  });

  it("built-in siteIds win: out-of-tree plugin with same siteId is disabled", async () => {
    // Temporarily register a built-in with the same siteId as our fixture.
    const { z } = await import("zod/v4");
    const fakeBuiltin = {
      meta: {
        siteId: "fixture-valid",
        displayName: "Built-in Fake",
        bodySchema: z.object({}),
        responseSchema: z.object({}),
      },
      execute: async () => ({ data: {} }),
    };

    BUILTIN_SITE_PLUGINS.push(fakeBuiltin as typeof fakeBuiltin);
    try {
      const { report } = await loadAllPlugins(makeConfig({ specifiers: [FIXTURE.validDefault] }));

      const outOfTreeRec = report.find((r) => r.specifier !== "(builtin)");
      expect(outOfTreeRec?.status).toBe("disabled");
      expect(outOfTreeRec?.reason).toMatch(/duplicate/i);
    } finally {
      // Restore the array to its original empty state.
      BUILTIN_SITE_PLUGINS.length = 0;
    }
  });
});
