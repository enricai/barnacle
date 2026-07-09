// @ts-check

const { z } = require("zod/v4");

// apiVersion major is 2, but core is 1.x — loadPlugins must disable this.
const plugin = {
  meta: {
    siteId: "fixture-apiver-mismatch",
    displayName: "Fixture API Version Mismatch",
    bodySchema: z.object({ query: z.string() }),
    responseSchema: z.object({ result: z.string() }),
    apiVersion: "2.0.0",
  },
  execute: async (_payload, _session, _context) => ({ data: { result: "ok" } }),
};

module.exports = plugin;
