// @ts-check

// Fixture executeHttp module referenced by a config manifest's spec.httpModule.
// Proves the escape hatch resolves a relative httpModule path against baseDir
// and attaches the exported function to the synthesized plugin.

/** @type {NonNullable<import("../../site-plugin").SitePlugin<unknown, unknown>["executeHttp"]>} */
const executeHttp = async (_payload, _context) => ({ data: { confirmationId: "HTTP-CONF-1" } });

module.exports = { executeHttp };
