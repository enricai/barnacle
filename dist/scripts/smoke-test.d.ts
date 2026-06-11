/**
 * Nightly validation: runs one request through a plugin's endpoint end-to-end
 * and validates the response envelope shape and HTTP status. Exits 0 on
 * success, non-zero on HTTP error or malformed envelope. Wire into CI and
 * cron — this is the first rung of the drift-detection ladder.
 *
 * Usage:
 *   pnpm run smoke -- --site <siteId> --payload '{"key":"value"}' \
 *     [--host http://localhost:3000] [--route <path>] [--fallback] \
 *     [--response-schema <path>] [--timeout <ms>]
 *
 * --response-schema must point to a TypeScript/JS module whose default export is a
 * Zod schema. The smoke test validates the full response body against it — not just
 * the envelope wrapper — so schema drift on the data payload fails loud and fast.
 *
 * Requires:
 *   - The server to be running (or pass --host to point at staging/prod)
 *   - API_KEY env var with a plaintext key that matches one of API_KEYS_HASHED
 *   - The target plugin to be registered and healthy
 */
export {};
