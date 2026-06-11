/**
 * Phase 4f: reads recon artifacts and generates a complete plugin skeleton —
 * contract.ts, flows/browser-flow.ts, index.ts, and fixtures/ — so no manual
 * coding is required between running recon and registering the plugin.
 *
 * Usage:
 *   pnpm run recon:generate -- --site-id my-site [--force]
 *
 * --force overwrites an existing src/sites/<siteId>/ directory.
 *
 * Reads from:
 *   /tmp/recon/graphql/*.json        — Capture[] from recon-browser.ts
 *   /tmp/recon/replays/*.json        — ReplayResult[] from recon-http.ts
 *   /tmp/recon/replays/rate-limit.json
 *   /tmp/recon/aux/*.json            — static fixture files
 *   src/sites/<siteId>/recon-flow.json — plain-English flow steps
 */
export {};
