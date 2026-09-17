// @ts-check

// Fixture httpModule referenced by a config manifest's spec.httpModule to
// prove spec.httpTimeoutMs reaches the module's own createHttpClient call.
// Records every options object it's constructed with so the test can assert
// on the received `defaultTimeoutMs`.

/** @type {HttpClientOptions[]} */
const receivedOptions = [];

/**
 * @typedef {{ defaultTimeoutMs?: number }} HttpClientOptions
 * @param {{ httpTimeoutMs?: number }} factoryOptions
 * @returns {NonNullable<import("../../site-plugin").SitePlugin<unknown, unknown>["executeHttp"]>}
 */
function createExecuteHttp(factoryOptions) {
  receivedOptions.push({ defaultTimeoutMs: factoryOptions.httpTimeoutMs });
  return async (_payload, _context) => ({ data: { confirmationId: "HTTP-CONF-TIMEOUT" } });
}

module.exports = { createExecuteHttp, receivedOptions };
