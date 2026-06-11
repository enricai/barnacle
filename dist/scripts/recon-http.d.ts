/**
 * Phase 2–3 recon: replays every capture from recon-browser.ts via plain
 * Node fetch() — no browser, no AI — to prove endpoints work standalone.
 *
 * Also runs:
 *   - GraphQL introspection probe on each unique GraphQL endpoint
 *   - Auxiliary endpoint probe: downloads static JSON fixtures (markets, currencies, etc.)
 *   - Rate-limit probe (1 → 3 → 5 rps, stops at first 429/403)
 *
 * Usage:
 *   pnpm tsx src/scripts/recon-http.ts [--captures-dir /tmp/recon/graphql]
 *
 * Outputs:
 *   /tmp/recon/replays/<filename>.json  — one replay result per unique capture
 *   /tmp/recon/aux/<basename>.json      — downloaded static fixture per auxiliary endpoint
 *   /tmp/recon/replays/rate-limit.json — rate-limit probe findings
 */
export {};
