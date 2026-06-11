/**
 * Iterates a site's replay-jobs.json fixture and runs recon-browser once
 * per job, allocating a fresh testmail inbox per run so the confirmation-
 * email delivery is an independent end-to-end signal. Aggregates a
 * per-job verdict (integrated_apply 200 captured? terminal URL? email
 * received?) and prints a final report.
 *
 * Why a separate runner instead of vitest: each recon-browser run boots
 * a real browser, executes the LLM-driven cascade, and writes to
 * /tmp/recon/. Running them under vitest interleaves logs, blocks on
 * fork-pool limits, and obscures per-run telemetry. A direct sequential
 * driver gives cleaner per-job artifacts and a single aggregated report.
 *
 * Usage:
 *   pnpm tsx --env-file=.env src/scripts/recon-replay-jobs.ts \
 *     --jobs src/sites/appcast/fixtures/replay-jobs.json \
 *     --flow-file src/sites/appcast/recon-flow.json \
 *     --report /tmp/recon/replay-report.json
 */
export {};
