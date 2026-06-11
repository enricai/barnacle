/**
 * Regression probe for `Locator.setInputFiles({ buffer })` semantics across
 * browser providers (Browserbase, Steel). Originally written as a one-off to
 * discover whether the buffer-payload-injection path actually works on a
 * remote Steel session — it doesn't, because Stagehand v3's payload-injection
 * code path is gated on `env === "BROWSERBASE"` and Steel runs as `env: "LOCAL"`,
 * falling through to a path-based CDP call that Steel's sandbox rejects with
 * `-32602 'DOM.setFileInputFiles' was blocked: file path is outside the
 * permitted directory`.
 *
 * Kept committed (and worth re-running) when:
 * - Upgrading Stagehand to confirm the buffer path still works on Browserbase.
 * - Switching browser providers to verify upload semantics on the new one.
 * - Debugging an upload regression in production scraping.
 *
 * Target: https://the-internet.herokuapp.com/upload — a public, well-known
 * test page with a single `<input type="file" id="file-upload">` and a
 * "File Uploaded!" success page that says the filename back.
 *
 * Pass criteria: setInputFiles attaches the buffer (input.files.length === 1)
 * AND clicking submit produces a success page body containing the filename.
 *
 * Usage:
 *   pnpm tsx --env-file=.env src/scripts/probe-setinputfiles.ts
 *   SCRAPER_PROVIDER=steel pnpm tsx --env-file=.env src/scripts/probe-setinputfiles.ts
 */
export {};
