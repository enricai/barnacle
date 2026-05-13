/**
 * Barrel export for the example site plugin. To register this plugin with
 * core, add one line to src/plugins/loader.ts:
 *
 *   import { examplePlugin } from "@/sites/example";
 *   SITE_PLUGINS.push(examplePlugin);
 *
 * That's the entire onboarding cost — no changes to core dispatch, routes,
 * auth, or health checks.
 */

export { examplePlugin } from "@/sites/example/contract";
