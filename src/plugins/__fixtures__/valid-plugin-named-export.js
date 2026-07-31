// @ts-check

const { z } = require("zod/v4");

/** @type {import("../../site-plugin").SitePlugin<unknown, unknown>} */
const plugin = {
  meta: {
    siteId: "fixture-named",
    displayName: "Fixture Named Export Plugin",
    bodySchema: z.object({ query: z.string() }),
    responseSchema: z.object({ result: z.string() }),
  },
  execute: async (_payload, _session, _context) => ({ data: { result: "ok" } }),
};

module.exports = { plugin };
