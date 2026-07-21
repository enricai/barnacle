import { afterEach, describe, expect, it, vi } from "vitest";

import { BUILTIN_SITE_PLUGINS } from "@/plugins/discover";
import type { SitePlugin } from "@/site-plugin";

/**
 * `buildServer()` registers an `onClose` hook that drains each loaded
 * plugin's `onShutdown` alongside the engine's own drains. `BUILTIN_SITE_PLUGINS`
 * is a mutable array kept exactly so tests can push a fixture plugin without
 * threading `BARNACLE_PLUGINS` through env vars — see discover.test.ts.
 */
function pushFixturePlugin(plugin: SitePlugin<unknown, unknown>): () => void {
  const originalLength = BUILTIN_SITE_PLUGINS.length;
  BUILTIN_SITE_PLUGINS.push(plugin);
  return () => {
    BUILTIN_SITE_PLUGINS.length = originalLength;
  };
}

async function makeFixturePlugin(
  siteId: string,
  onShutdown?: () => Promise<void>
): Promise<SitePlugin<unknown, unknown>> {
  const { z } = await import("zod/v4");
  return {
    meta: {
      siteId,
      displayName: siteId,
      bodySchema: z.object({}),
      responseSchema: z.object({}),
      onShutdown,
    },
    execute: async () => ({ data: {} }),
  } as unknown as SitePlugin<unknown, unknown>;
}

describe("buildServer onClose plugin drain", () => {
  const restores: Array<() => void> = [];

  afterEach(() => {
    // Restore in reverse (LIFO) order: each restore's captured originalLength
    // is relative to the array state at push time, so restoring out of order
    // leaves a hole instead of an empty array.
    for (const restore of restores.splice(0).reverse()) restore();
    vi.restoreAllMocks();
  });

  it("awaits a loaded plugin's onShutdown on app.close()", async () => {
    const onShutdown = vi.fn().mockResolvedValue(undefined);
    restores.push(pushFixturePlugin(await makeFixturePlugin("fixture-drain", onShutdown)));

    const { buildServer } = await import("@/server.js");
    const app = await buildServer();
    await app.close();

    expect(onShutdown).toHaveBeenCalledTimes(1);
  });

  it("a throwing plugin's onShutdown does not block another plugin's drain", async () => {
    const failingShutdown = vi.fn().mockRejectedValue(new Error("boom"));
    const healthyShutdown = vi.fn().mockResolvedValue(undefined);
    restores.push(pushFixturePlugin(await makeFixturePlugin("fixture-throws", failingShutdown)));
    restores.push(pushFixturePlugin(await makeFixturePlugin("fixture-healthy", healthyShutdown)));

    const { buildServer } = await import("@/server.js");
    const app = await buildServer();
    await expect(app.close()).resolves.toBeUndefined();

    expect(failingShutdown).toHaveBeenCalledTimes(1);
    expect(healthyShutdown).toHaveBeenCalledTimes(1);
  });

  it("a plugin with no onShutdown is unaffected and does not warn", async () => {
    restores.push(pushFixturePlugin(await makeFixturePlugin("fixture-no-shutdown")));

    const { buildServer } = await import("@/server.js");
    const app = await buildServer();
    await expect(app.close()).resolves.toBeUndefined();
  });
});
