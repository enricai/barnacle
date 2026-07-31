// @ts-check

// bodySchema is a plain object, not a Zod schema — duck-type check must reject this.
const plugin = {
  meta: {
    siteId: "fixture-bad-bodyschema",
    displayName: "Fixture Bad bodySchema",
    bodySchema: { notAZodSchema: true },
    responseSchema: { notAZodSchema: true },
  },
  execute: async () => ({ data: {} }),
};

module.exports = plugin;
