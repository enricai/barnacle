// @ts-check

const { z } = require("zod/v4");

/** @type {import("../../site-plugin").SitePlugin<unknown, unknown>} */
const plugin = {
  meta: {
    siteId: "fixture-valid-redaction",
    displayName: "Fixture Valid Redaction",
    bodySchema: z.object({ query: z.string() }),
    responseSchema: z.object({ result: z.string() }),
    redaction: { persistKeys: ["orderId"], wordKeys: ["fullName"], digitKeys: ["phone"] },
  },
  execute: async () => ({ data: { result: "ok" } }),
};

module.exports = plugin;
