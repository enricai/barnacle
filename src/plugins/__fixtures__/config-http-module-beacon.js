// @ts-check

// Fixture executeHttp module referenced by a config manifest's spec.httpModule.
// Proves a config-only (zero-TypeScript) plugin can reach context.recordBeaconOutcome
// through the httpModule escape hatch — the only manifest-side seam, since the
// config plugin's browser execute is data-driven via runHealingFlow and cannot
// call the recorder itself.

/** @type {NonNullable<import("../../site-plugin").SitePlugin<unknown, unknown>["executeHttp"]>} */
const executeHttp = async (_payload, context) => {
  await context.recordBeaconOutcome({
    beaconStatus: "fired",
    joinKeys: { opaque: { nested: 1 } },
  });
  return { data: { confirmationId: "HTTP-CONF-1" } };
};

module.exports = { executeHttp };
