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
 *   pnpm tsx src/scripts/migrate-telemetry-dir-names.ts --site <siteId> --apply
 */

import { existsSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

import { getScriptLogger } from "@/lib/logging";
import { urlDirName } from "@/lib/telemetry/telemetry-paths";

const logger = getScriptLogger("migrate-telemetry-dir-names");

const ALREADY_MIGRATED_RX = /^\d+-[0-9a-f]{8}$/;

interface MigrateOptions {
  /** Path to the project root containing `src/sites/`. */
  sitesRoot: string;
  /** Optional: restrict to one site directory by name (e.g. "acme-jobs"). */
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
export function migrateTelemetryDirs(opts: MigrateOptions): MigrationOutcome {
  const outcome: MigrationOutcome = { migrated: 0, alreadyMigrated: 0, warnings: 0 };
  if (!existsSync(opts.sitesRoot)) {
    logger.warn(`sites root not found: ${opts.sitesRoot}`);
    outcome.warnings++;
    return outcome;
  }
  const siteDirs = readdirSync(opts.sitesRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .filter((d) => opts.siteFilter === null || d.name === opts.siteFilter)
    .map((d) => join(opts.sitesRoot, d.name));
  for (const siteDir of siteDirs) {
    const runsDir = join(siteDir, "telemetry", "runs");
    if (!existsSync(runsDir)) continue;
    migrateRunsDir(runsDir, opts.apply, outcome);
  }
  return outcome;
}

/**
 * Per-`runs/` walker. Inspects every child entry; rename-eligible ones get
 * routed to renamePartition, which is also where dry-run vs apply is gated.
 */
function migrateRunsDir(runsDir: string, apply: boolean, outcome: MigrationOutcome): void {
  const partitions = readdirSync(runsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  for (const partition of partitions) {
    const partitionPath = join(runsDir, partition.name);
    if (ALREADY_MIGRATED_RX.test(partition.name)) {
      logger.info(`skip (already migrated): ${partitionPath}`);
      outcome.alreadyMigrated++;
      continue;
    }
    renamePartition(runsDir, partition.name, apply, outcome);
  }
}

/**
 * Compute the target name from `url.txt` + mtime, then dry-run-or-rename.
 * Skips with a warning when the partition is missing the sidecar (can't
 * recover URL), when the target already exists (collision; needs manual
 * triage), or when mtime can't be read.
 */
function renamePartition(
  runsDir: string,
  oldName: string,
  apply: boolean,
  outcome: MigrationOutcome
): void {
  const partitionPath = join(runsDir, oldName);
  const urlTxtPath = join(partitionPath, "url.txt");
  if (!existsSync(urlTxtPath)) {
    logger.warn(`skip (no url.txt): ${partitionPath}`);
    outcome.warnings++;
    return;
  }
  const url = readFileSync(urlTxtPath, "utf8").trim();
  if (url.length === 0) {
    logger.warn(`skip (empty url.txt): ${partitionPath}`);
    outcome.warnings++;
    return;
  }
  const callsPath = join(partitionPath, "calls.ndjson");
  const mtimeMs = existsSync(callsPath)
    ? Math.round(statSync(callsPath).mtimeMs)
    : Math.round(statSync(partitionPath).mtimeMs);
  const newName = urlDirName(mtimeMs, url);
  if (newName === oldName) {
    logger.info(`skip (same name): ${partitionPath}`);
    outcome.alreadyMigrated++;
    return;
  }
  const newPath = join(runsDir, newName);
  if (existsSync(newPath)) {
    logger.warn(`skip (target collision): ${partitionPath} → ${newPath}`);
    outcome.warnings++;
    return;
  }
  if (apply) {
    renameSync(partitionPath, newPath);
    logger.info(`renamed: ${oldName} → ${newName} (in ${runsDir})`);
  } else {
    logger.info(`dry-run: ${oldName} → ${newName} (in ${runsDir})`);
  }
  outcome.migrated++;
}

interface ParsedArgs {
  apply: boolean;
  siteFilter: string | null;
}

/**
 * Tiny argv parser matching the rest of the scripts in this dir. Exposed
 * for unit tests; defaults to dry-run (apply=false).
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  let apply = false;
  let siteFilter: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--apply") {
      apply = true;
    } else if (arg === "--site" && args[i + 1]) {
      siteFilter = args[++i] ?? null;
    }
  }
  return { apply, siteFilter };
}

async function main(): Promise<void> {
  const { apply, siteFilter } = parseArgs(process.argv);
  const sitesRoot = join(process.cwd(), "src", "sites");
  logger.info(
    `migrate-telemetry-dir-names: sitesRoot=${sitesRoot} siteFilter=${siteFilter ?? "(all)"} apply=${apply}`
  );
  const outcome = migrateTelemetryDirs({ sitesRoot, siteFilter, apply });
  logger.info(
    `summary: ${outcome.migrated} ${apply ? "renamed" : "planned"}, ${outcome.alreadyMigrated} skipped (already migrated), ${outcome.warnings} warning(s)`
  );
  if (!apply && outcome.migrated > 0) {
    logger.info(`re-run with --apply to execute the renames`);
  }
}

main().catch((err: unknown) => {
  logger.error(
    `migrate-telemetry-dir-names failed: ${err instanceof Error ? err.message : String(err)}`
  );
  process.exit(1);
});
