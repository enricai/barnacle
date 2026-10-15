// @ts-check

const { z } = require("zod/v4");

// persistKeys is a string, not an array — validatePluginShape must reject this
// (`includes` on a string would substring-match keys and persist their values).
const plugin = {
  meta: {
    siteId: "fixture-bad-redaction",
    displayName: "Fixture Bad Redaction",
    bodySchema: z.object({ query: z.string() }),
    responseSchema: z.object({ result: z.string() }),
    redaction: { persistKeys: "orderId" },
  },
  execute: async () => ({ data: { result: "ok" } }),
};

module.exports = plugin;
