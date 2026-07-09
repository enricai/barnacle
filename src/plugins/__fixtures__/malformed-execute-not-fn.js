// @ts-check

const { z } = require("zod/v4");

// execute is a string, not a function — validatePluginShape must reject this.
const plugin = {
  meta: {
    siteId: "fixture-bad-execute",
    displayName: "Fixture Bad Execute",
    bodySchema: z.object({ query: z.string() }),
    responseSchema: z.object({ result: z.string() }),
  },
  execute: "not-a-function",
};

module.exports = plugin;
