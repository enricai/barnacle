/**
 * Fetch half of the durable S3 read path: pulls the NDJSON objects named by
 * an already-supplied key list (`submissions-s3-objects.ts`'s
 * `listSubmissionsS3Objects`) with bounded concurrency and parses each body
 * into `ReconciliationRecord[]` via `submission-reader.ts`'s
 * `parseReconciliationLines`, so telemetry that only survives in S3 (ECS
 * containers are ephemeral and per-task) becomes readable. Folding beacon
 * lines onto submit records and merging with the local sink live elsewhere.
 *
 * Mirrors `s3-sink.ts`'s inertness contract: no `S3Client` construction, no
 * network calls, when `config.telemetry.s3.bucket` is unset.
 */

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import PQueue from "p-queue";

import { config } from "@/config";
import { toErrorMessage } from "@/lib/errors";
import { getLogger } from "@/lib/logging";
import type { ReconciliationRecord } from "@/lib/telemetry/reconciliation-record";
import { parseReconciliationLines } from "@/lib/telemetry/submission-reader";

const logger = getLogger({ name: "telemetry/submissions-s3-reader" });

let client: S3Client | undefined;

/** Lazily constructs the S3 client. Never called on the bucket-unset path. */
function getClient(): S3Client {
  if (!client) {
    client = new S3Client({ region: config.bedrock.region });
  }
  return client;
}

/** Fetches and parses one object's body. Empty body yields no records rather than throwing. */
async function fetchObjectRecords(bucket: string, key: string): Promise<ReconciliationRecord[]> {
  const response = await getClient().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = await response.Body?.transformToString();
  return body ? parseReconciliationLines(body) : [];
}

/**
 * Fetches every listed S3 object and parses its NDJSON body into
 * reconciliation records. Objects are fetched through a `p-queue` bounded by
 * `config.telemetry.s3.readConcurrency` — no hand-rolled promise pooling per
 * CLAUDE.md's battle-tested-libraries rule. A single object's `GetObject`
 * failure is logged and skipped rather than aborting the read, matching the
 * swallow-and-log posture the rest of `src/lib/telemetry` uses: a read
 * failure should degrade the answer, never 500 the route. Returns `[]`
 * without constructing an `S3Client` when no bucket is configured.
 */
export async function fetchSubmissionsS3Records(keys: string[]): Promise<ReconciliationRecord[]> {
  const bucket = config.telemetry.s3.bucket;
  if (!bucket) return [];

  const queue = new PQueue({ concurrency: config.telemetry.s3.readConcurrency });
  const results = await Promise.all(
    keys.map((key) =>
      queue
        .add(() => fetchObjectRecords(bucket, key))
        .catch((err) => {
          logger.warn(
            `submissions-s3-reader: fetch of ${key} failed, skipping: ${toErrorMessage(err)}`
          );
          return undefined;
        })
    )
  );

  return results.flatMap((records) => records ?? []);
}
