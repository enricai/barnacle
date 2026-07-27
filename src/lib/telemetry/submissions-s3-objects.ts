/**
 * Object-discovery half of the durable S3 read path: enumerates the
 * `<prefix>/submissions/<YYYY-MM-DD>/` keys that could contain rows for a
 * requested `from`/`to` window, so the fetch stage (feat-003) never has to
 * scan the whole telemetry bucket. Entirely inert (no `S3Client`
 * construction, no network calls) when `config.telemetry.s3.bucket` is
 * unset — mirrors `s3-sink.ts`'s inertness contract.
 */

import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { addDays, eachDayOfInterval, formatISO, parseISO, subDays } from "date-fns";

import { config } from "@/config";
import { getLogger } from "@/lib/logging";

const logger = getLogger({ name: "telemetry/submissions-s3-objects" });

const SUBMISSIONS_DIR = "submissions";

/**
 * Bound on how far back an open-ended window reaches. Matches
 * `TELEMETRY_MAX_RETENTION_MS`'s existing 30-day default so a query that
 * omits `from` can't be asked to enumerate the bucket's entire history.
 */
const DEFAULT_WINDOW_DAYS = 30;

let client: S3Client | undefined;

/** Lazily constructs the S3 client. Never called on the bucket-unset path. */
function getClient(): S3Client {
  if (!client) {
    client = new S3Client({ region: config.bedrock.region });
  }
  return client;
}

/** Filter window for `listSubmissionsS3Objects`. Both bounds are ISO datetime strings. */
export interface ListSubmissionsS3ObjectsOptions {
  from?: string;
  to?: string;
}

/**
 * Resolves the inclusive `from`/`to` `Date` bounds used for day-prefix
 * enumeration. `to` defaults to `now` (submissions can't exist in the
 * future); `from` defaults to `DEFAULT_WINDOW_DAYS` before `to` so an
 * unbounded query is still capped.
 */
function resolveWindow(opts: ListSubmissionsS3ObjectsOptions, now: Date): { from: Date; to: Date } {
  const to = opts.to ? parseISO(opts.to) : now;
  const from = opts.from ? parseISO(opts.from) : subDays(to, DEFAULT_WINDOW_DAYS);
  return { from, to };
}

/**
 * Builds the day-partition prefixes to scan, widened by one day on each
 * side of the requested window. Day partitions are stamped at flush time
 * with `new Date()` (`s3-sink.ts`'s `buildObjectKey`), so a run whose `ts`
 * falls near a day boundary can land in the adjacent day's partition
 * relative to its own timestamp. The row-level `from`/`to` predicate in
 * `submission-query.ts` does the exact filtering; this only needs to not
 * miss a partition.
 */
function dayPrefixes(from: Date, to: Date, prefix: string): string[] {
  const days = eachDayOfInterval({ start: subDays(from, 1), end: addDays(to, 1) });
  return days.map(
    (day) => `${prefix}/${SUBMISSIONS_DIR}/${formatISO(day, { representation: "date" })}/`
  );
}

/** Result of listing one day-prefix: the keys found and whether the budget cut the listing short. */
interface PrefixListResult {
  keys: string[];
  truncated: boolean;
}

/**
 * Lists every object key under one day-partition prefix, following
 * `NextContinuationToken` to exhaustion, stopping early once `budget` keys
 * have been collected. `truncated` distinguishes "budget exhausted mid-list"
 * from "listing finished naturally," so the caller only warns when the cap
 * actually dropped objects.
 */
async function listPrefixKeys(
  bucket: string,
  prefix: string,
  budget: number
): Promise<PrefixListResult> {
  if (budget <= 0) return { keys: [], truncated: true };

  const keys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const response = await getClient().send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );
    for (const object of response.Contents ?? []) {
      if (object.Key === undefined) continue;
      if (keys.length >= budget) return { keys, truncated: true };
      keys.push(object.Key);
    }
    continuationToken = response.NextContinuationToken;
  } while (continuationToken !== undefined);

  return { keys, truncated: false };
}

/**
 * Enumerates the S3 object keys that could contain submissions rows for the
 * requested `from`/`to` window. Returns `[]` without constructing an
 * `S3Client` when no bucket is configured. The result is capped at
 * `config.telemetry.s3.readMaxObjects` — logged with a warning when the cap
 * actually truncated the listing — so a query spanning months of shipped
 * NDJSON can't fan out unbounded S3 calls in the fetch stage that follows.
 */
export async function listSubmissionsS3Objects(
  opts: ListSubmissionsS3ObjectsOptions = {}
): Promise<string[]> {
  const bucket = config.telemetry.s3.bucket;
  if (!bucket) return [];

  const { from, to } = resolveWindow(opts, new Date());
  const prefixes = dayPrefixes(from, to, config.telemetry.s3.prefix);
  const maxObjects = config.telemetry.s3.readMaxObjects;

  const keys: string[] = [];
  let truncated = false;

  for (const prefix of prefixes) {
    const budget = maxObjects - keys.length;
    if (budget <= 0) {
      truncated = true;
      break;
    }
    const result = await listPrefixKeys(bucket, prefix, budget);
    keys.push(...result.keys);
    if (result.truncated) {
      truncated = true;
      break;
    }
  }

  if (truncated) {
    logger.warn(
      `submissions-s3-objects: key listing capped at readMaxObjects=${maxObjects}; some objects in the requested window were not returned`
    );
  }

  return keys;
}
