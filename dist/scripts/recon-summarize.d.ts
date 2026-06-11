/**
 * Phase 4e: reads captures and replays produced by recon-browser.ts and
 * recon-http.ts and generates docs/target-recon.md — the findings document
 * a teammate needs when the integration breaks.
 *
 * Usage:
 *   pnpm tsx src/scripts/recon-summarize.ts \
 *     [--site-id <id>] [--out docs/target-recon.md]
 *
 * When --site-id is provided, path placeholders in the output (src/sites/<id>/...)
 * are replaced with the real site ID and the default output path becomes
 * docs/<site-id>-recon.md.
 */
export {};
