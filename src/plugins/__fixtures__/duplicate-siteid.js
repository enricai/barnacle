// @ts-check

const { z } = require("zod/v4");

// siteId "fixture-valid" collides with valid-default-export.js — second load must be disabled.
const plugin = {
  meta: {
    siteId: "fixture-valid",
    displayName: "Fixture Duplicate siteId",
    bodySchema: z.object({ query: z.string() }),
    responseSchema: z.object({ result: z.string() }),
  },
  execute: async (_payload, _session, _context) => ({ data: { result: "ok" } }),
};

module.exports = plugin;
