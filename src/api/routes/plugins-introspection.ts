import type { FastifyInstance } from "fastify";

import type { PluginLoadRecord } from "@/plugins/discover";

/**
 * Injectable options for `pluginsIntrospectionRoutes`. The report is passed
 * in at registration time so the route can be tested without spinning up the
 * full server and plugin-loading pipeline.
 */
export interface PluginsIntrospectionOptions {
  report: PluginLoadRecord[];
}

/**
 * Exposes the plugin load report behind authentication. Separate from
 * `healthRoutes` because it reveals filesystem paths (resolved plugin paths)
 * that must not be visible to unauthenticated callers.
 */
export async function pluginsIntrospectionRoutes(
  app: FastifyInstance,
  options: PluginsIntrospectionOptions
): Promise<void> {
  const { report } = options;

  app.get(
    "/v1/plugins",
    { onRequest: [app.authenticate] },
    async (): Promise<PluginLoadRecord[]> => report
  );
}
