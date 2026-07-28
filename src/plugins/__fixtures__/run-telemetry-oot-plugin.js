// @ts-check

const { z } = require("zod/v4");

/** @type {import("../../site-plugin").SitePlugin<unknown, unknown>} */
const plugin = {
  meta: {
    siteId: "run-telemetry-oot",
    displayName: "Run Telemetry Out-of-Tree Plugin",
    bodySchema: z.object({ query: z.string() }),
    responseSchema: z.object({ result: z.string() }),
  },
  execute: async (_payload, _session, context) => {
    context.telemetry.addJoinKeys({ discoveredToken: "mid-run-abc123" });
    return { data: { result: "oot-telemetry-ok" } };
  },
};

module.exports = plugin;
