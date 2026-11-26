import { describe, expect, it } from "vitest";

import { createInMemoryIdempotencyStore, preSubmitStoreKey } from "@/cache/idempotency-guard";
import type { AppConfig } from "@/config";
import { getLogger } from "@/lib/logging";
import { buildPluginContext } from "@/plugins/loader";
import type { SitePlugin } from "@/site-plugin";

describe("buildPluginContext — recordPreSubmit", () => {
  it("persists key names only, readable after it resolves", async () => {
    const store = createInMemoryIdempotencyStore();
    const ctx = buildPluginContext({
      plugin: { meta: { siteId: "s1" } } as unknown as SitePlugin<unknown, unknown>,
      cfg: { scraper: { siteBaseUrls: {} } } as unknown as AppConfig,
      requestId: "r1",
      logger: getLogger({ name: "pre-submit-test" }),
      preSubmitStore: store,
    });
    await ctx.recordPreSubmit({ stepIndex: 2, payload: { ssn: "123-45-6789", name: "Zed" } });
    const rec = await store.get(preSubmitStoreKey("s1", "r1", 2));
    expect(rec).toMatchObject({
      state: "pending",
      preSubmit: { siteId: "s1", requestId: "r1", stepIndex: 2, payloadKeys: ["name", "ssn"] },
    });
    expect(JSON.stringify(rec)).not.toContain("123-45-6789");
    expect(JSON.stringify(rec)).not.toContain("Zed");
  });
});
