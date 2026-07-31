// @ts-check

const { z } = require("zod/v4");

/** @type {import("../../site-plugin").SitePlugin<unknown, unknown>} */
const plugin = {
  meta: {
    siteId: "e2e-plugin",
    displayName: "E2E Out-of-Tree Plugin",
    bodySchema: z.object({ query: z.string() }),
    responseSchema: z.object({ result: z.string() }),
  },
  execute: async (_payload, _session, _context) => ({ data: { result: "e2e-ok" } }),
};

module.exports = plugin;
