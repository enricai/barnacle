/**
 * Kubernetes-style envelope constants for config-plugin manifests. Kept in a
 * tiny leaf module (no heavy imports) so both the runtime loader
 * (`config-plugin.ts`, which validates with `z.literal`) and the build-time
 * emitter (`recon-generate.ts`, which writes manifests) share one source of
 * truth — a version bump can't silently desync the emitter from the gate.
 */

/**
 * Manifest `apiVersion` the config-plugin factory understands (K8s
 * `group/version`). Its major segment tracks `PLUGIN_API_VERSION`, the runtime
 * plugin-API contract in `plugin-api-version.ts`.
 */
export const CONFIG_PLUGIN_API_VERSION = "barnacle.dev/v1" as const;

/** Manifest `kind` the config-plugin factory understands. */
export const CONFIG_PLUGIN_KIND = "SitePlugin" as const;
