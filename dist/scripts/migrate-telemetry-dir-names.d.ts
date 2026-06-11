/**
 * One-off migration: rename existing base64-encoded telemetry run directories
 * to the new `<unix-ms>-<short-hash>` scheme introduced in commit ce63526.
 *
 * Background: until ce63526, per-URL telemetry partitions were named
 * `runs/<base64url-canonical-url>/` (e.g.
 * `aHR0cHM6Ly9jbGljay5hcHBjYXN0Lmlv...`). After ce63526, new runs create
 * `runs/<unix-ms>-<sha1-hex-8>/` directories. The engine reads both styles
 * (readSiteCallsNdjson walks all dirs blindly), so mixed naming is
 * functionally harmless — but visually inconsistent and prevents the new
 * `awk -F- '{print $NF}' | sort | uniq -c` URL-grouping pattern from
 * working on historical data.
 *
 * This script walks every `src/sites/<site>/telemetry/runs/` tree, reads
 * each partition's `url.txt` sidecar to recover the original URL, and
 * renames the dir to the new scheme. The timestamp is sourced from the
 * mtime of the partition's `calls.ndjson` (when this run actually wrote
 * data) or falls back to the dir's mtime when there's no NDJSON yet.
 *
 * Idempotent: dirs already in the new shape are skipped.
 * Safe: dry-run is the default; `--apply` is required to actually rename.
 *
 * Usage:
 *   pnpm tsx src/scripts/migrate-telemetry-dir-names.ts
 *   pnpm tsx src/scripts/migrate-telemetry-dir-names.ts --apply
 *   pnpm tsx src/scripts/migrate-telemetry-dir-names.ts --site appcast --apply
 */
interface MigrateOptions {
    /** Path to the project root containing `src/sites/`. */
    sitesRoot: string;
    /** Optional: restrict to one site directory by name (e.g. "appcast"). */
    siteFilter: string | null;
    /** If false, log planned renames but do not execute them. */
    apply: boolean;
}
interface MigrationOutcome {
    migrated: number;
    alreadyMigrated: number;
    warnings: number;
}
/**
 * Drive the migration end-to-end across every site under `sitesRoot`.
 * Returns a tally so callers (CLI + tests) can assert outcomes without
 * scraping log output.
 */
export declare function migrateTelemetryDirs(opts: MigrateOptions): MigrationOutcome;
interface ParsedArgs {
    apply: boolean;
    siteFilter: string | null;
}
/**
 * Tiny argv parser matching the rest of the scripts in this dir. Exposed
 * for unit tests; defaults to dry-run (apply=false).
 */
export declare function parseArgs(argv: string[]): ParsedArgs;
export {};
