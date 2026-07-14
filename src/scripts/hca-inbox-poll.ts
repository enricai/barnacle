/**
 * Standalone confirmation-email poller for the HCA batch — DECOUPLED from the
 * live-verify run so it never slows a submission. Reads the batch log, extracts
 * every SUBMITTED job's testmail inbox (`{jobId, address, tag, timestampFrom}`),
 * and polls each inbox for a confirmation email. Idempotent + re-runnable: pass
 * the same `--out` file across runs and it only polls inboxes not yet confirmed,
 * so it can be run repeatedly as emails trickle in (HCA/Talemetry may email
 * minutes-to-hours after submit, or not at all — this measures which).
 *
 * Usage:
 *   pnpm tsx --env-file=.env src/scripts/hca-inbox-poll.ts \
 *     [--log <batch.log>] [--out <results.json>] [--timeout-ms <per-inbox budget>]
 *
 * "SUBMITTED" is already the authoritative in-band success signal (Talemetry
 * completed=true + thank-you URL); this is an ADDITIONAL out-of-band check to
 * learn whether HCA actually delivers a confirmation email.
 */

import { readFileSync, writeFileSync } from "node:fs";

import { config } from "@/config";
import { getLogger } from "@/lib/logging";
import { pollTestmailInbox } from "@/testmail/client";

const logger = getLogger({ name: "hca-inbox-poll" });

const DEFAULT_LOG =
  "/private/tmp/claude-501/-Users-andres-src-vivian-barnacle/2c51c4a7-1a01-4e80-a3ad-8c8d02045529/scratchpad/hca-allvalid.log";
const DEFAULT_OUT =
  "/private/tmp/claude-501/-Users-andres-src-vivian-barnacle/2c51c4a7-1a01-4e80-a3ad-8c8d02045529/scratchpad/hca-inbox-results.json";

/** One submitted job's inbox, reconstructed from the batch log. */
interface SubmittedInbox {
  jobId: string;
  address: string;
  tag: string;
  timestampFrom: number;
}

/** The persisted per-inbox confirmation result. */
interface InboxResult {
  jobId: string;
  address: string;
  confirmed: boolean;
  subject: string | null;
  from: string | null;
  checkedAt: string;
}

function parseArgs(): { logPaths: string[]; outPath: string; timeoutMs: number } {
  const args = process.argv.slice(2);
  const logPaths: string[] = [];
  let outPath = DEFAULT_OUT;
  let timeoutMs = 15_000;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--log" && args[i + 1]) logPaths.push(args[++i]!);
    else if (args[i] === "--out" && args[i + 1]) outPath = args[++i]!;
    else if (args[i] === "--timeout-ms" && args[i + 1]) timeoutMs = Number(args[++i]);
  }
  return { logPaths: logPaths.length > 0 ? logPaths : [DEFAULT_LOG], outPath, timeoutMs };
}

/**
 * Reconstruct each SUBMITTED job's inbox from the batch log. A "starting" line
 * carries `job=<id> email=<namespace>.<tag>@inbox.testmail.app` + a timestamp;
 * a later `job=<id> SUBMITTED` line confirms it applied. The address yields the
 * tag; the starting line's clock is a safe `timestampFrom` lower bound.
 */
function parseSubmittedInboxes(log: string): SubmittedInbox[] {
  const byJob = new Map<string, { address: string; tag: string; timestampFrom: number }>();
  const lines = log.split("\n");
  for (const line of lines) {
    const m =
      /\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)[^\]]*\].*job=(\d+) email=([^ ]+@inbox\.testmail\.app)/.exec(
        line
      );
    if (!m) continue;
    const [, clock, jobId, address] = m;
    const tag = address!.split("@")[0]!.split(".").slice(1).join(".");
    // The starting clock (local time) → Unix ms lower bound for received-after.
    const timestampFrom = new Date(clock!.replace(" ", "T")).getTime();
    byJob.set(jobId!, { address: address!, tag, timestampFrom });
  }
  const submitted = new Set<string>();
  for (const m of log.matchAll(/job=(\d+) SUBMITTED/g)) {
    submitted.add(m[1]!);
  }
  const out: SubmittedInbox[] = [];
  for (const jobId of submitted) {
    const info = byJob.get(jobId);
    if (info) out.push({ jobId, ...info });
  }
  return out;
}

function loadPriorResults(outPath: string): Map<string, InboxResult> {
  try {
    const arr = JSON.parse(readFileSync(outPath, "utf8")) as InboxResult[];
    return new Map(arr.map((r) => [r.jobId, r]));
  } catch {
    return new Map();
  }
}

/**
 * Poll every not-yet-confirmed submitted inbox once and persist results. Exists
 * as a discrete script so it can run on its own cadence beside the live batch.
 */
async function main(): Promise<void> {
  const { logPaths, outPath, timeoutMs } = parseArgs();
  if (!config.testmail.namespace) {
    throw new Error("TESTMAIL_NAMESPACE not set — cannot poll inboxes");
  }

  // Merge submitted inboxes from every log (original batch + any resume runs),
  // deduped by jobId so re-run jobs don't double-poll.
  const byJob = new Map<string, SubmittedInbox>();
  for (const p of logPaths) {
    let text: string;
    try {
      text = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    for (const inb of parseSubmittedInboxes(text)) byJob.set(inb.jobId, inb);
  }
  const inboxes = [...byJob.values()];
  const prior = loadPriorResults(outPath);
  const pending = inboxes.filter((x) => prior.get(x.jobId)?.confirmed !== true);

  logger.info(
    `hca-inbox-poll: ${inboxes.length} submitted inbox(es); ${prior.size} prior result(s); polling ${pending.length} not-yet-confirmed`
  );

  const results = new Map(prior);
  let newlyConfirmed = 0;
  for (const inb of pending) {
    try {
      const msg = await pollTestmailInbox({
        inbox: { address: inb.address, tag: inb.tag, timestampFrom: inb.timestampFrom },
        timeoutMs,
      });
      results.set(inb.jobId, {
        jobId: inb.jobId,
        address: inb.address,
        confirmed: true,
        subject: msg.subject,
        from: msg.from,
        checkedAt: new Date().toISOString(),
      });
      newlyConfirmed++;
      logger.info(
        `hca-inbox-poll: job ${inb.jobId} CONFIRMED — from="${msg.from}" subject="${msg.subject}"`
      );
    } catch (err) {
      // Any throw (timeout = no email within budget, or a transient API error)
      // → not confirmed THIS pass; a later re-run retries it.
      results.set(inb.jobId, {
        jobId: inb.jobId,
        address: inb.address,
        confirmed: false,
        subject: null,
        from: null,
        checkedAt: new Date().toISOString(),
      });
      logger.info(
        `hca-inbox-poll: job ${inb.jobId} no confirmation (${err instanceof Error ? err.constructor.name : "error"})`
      );
    }
  }

  const all = [...results.values()];
  writeFileSync(outPath, JSON.stringify(all, null, 2));
  const confirmed = all.filter((r) => r.confirmed).length;
  logger.info(
    `hca-inbox-poll: DONE — ${confirmed}/${all.length} confirmed (${newlyConfirmed} new this run). Results: ${outPath}`
  );
}

main().catch((err) => {
  logger.error(`hca-inbox-poll: fatal — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
