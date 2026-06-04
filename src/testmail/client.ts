import { randomUUID } from "node:crypto";

import Bottleneck from "bottleneck";
import { z } from "zod/v4";

import { config } from "@/config";
import { getLogger } from "@/lib/logging";
import { createGraphqlClient } from "@/scraper/graphql-client";
import { TestmailApiError, TestmailTimeoutError } from "@/testmail/errors";

const logger = getLogger({ name: "testmail/client" });

const TESTMAIL_ENDPOINT = "https://api.testmail.app/api/graphql";

/**
 * Sustained per-key rate-limit ceiling per testmail docs (5 rps). Pinning
 * to 4 rps leaves headroom for the inbox-query loop + any concurrent
 * callers (e.g. multiple integration tests sharing the namespace).
 */
const TESTMAIL_MIN_TIME_MS = 250;

/** Default total wait budget for `pollTestmailInbox`. Calibrated for typical receipt-email latency (10-30s). */
const DEFAULT_POLL_TIMEOUT_MS = 60_000;

/**
 * Default per-iteration wait between inbox queries. The query itself uses
 * `livequery: true` which long-polls server-side, so we sleep this much
 * BETWEEN queries — not as the primary wait mechanism.
 */
const DEFAULT_POLL_INTERVAL_MS = 2_000;

const InboxQueryResponseSchema = z.object({
  data: z.object({
    inbox: z.object({
      result: z.string(),
      message: z.string().nullable().optional(),
      count: z.number(),
      emails: z.array(
        z.object({
          id: z.string(),
          from: z.string(),
          subject: z.string(),
          text: z.string().nullable().optional(),
          html: z.string().nullable().optional(),
          date: z.number(),
        })
      ),
    }),
  }),
});

/** An address allocated for a single recon run / integration test. */
export interface TestmailInbox {
  /** Full address: `{namespace}.{tag}@inbox.testmail.app`. */
  address: string;
  /** Tag piece — used as the GraphQL query filter to scope reads to this inbox. */
  tag: string;
  /** Allocation timestamp (Unix ms) — passed to the inbox query so we only see emails received AFTER allocation. */
  timestampFrom: number;
}

/**
 * Single message returned by the inbox query. Shaped to match the GraphQL
 * response one-to-one so the polling loop doesn't need to remap.
 */
export interface TestmailMessage {
  id: string;
  from: string;
  subject: string;
  text: string | null;
  html: string | null;
  /** Unix ms timestamp (per testmail GraphQL `Float`). */
  date: number;
}

export interface AllocateTestmailInboxOptions {
  /** Override the configured namespace (`TESTMAIL_NAMESPACE`). Mostly useful for tests. */
  namespace?: string;
}

export interface PollTestmailInboxOptions {
  inbox: TestmailInbox;
  /** Substring match against `subject` (case-insensitive). Omit to return any new message. */
  subjectContains?: string;
  /** Total wait budget in ms. Default 60_000. */
  timeoutMs?: number;
  /** Sleep between iterations in ms. Default 2_000. */
  intervalMs?: number;
}

/**
 * Allocate a fresh testmail.app inbox address. No network call — testmail
 * uses dynamic subaddressing, so any `{namespace}.{tag}@inbox.testmail.app`
 * is implicitly valid the moment we generate it. The 8-char random tag
 * makes collisions vanishingly unlikely without persisting state.
 *
 * The returned `timestampFrom` is the allocation moment in Unix ms; the
 * polling helper filters the inbox query by this so we never see messages
 * from previous allocations (the namespace is shared across all runs).
 */
export function allocateTestmailInbox(opts: AllocateTestmailInboxOptions = {}): TestmailInbox {
  const namespace = opts.namespace ?? config.testmail.namespace;
  if (!namespace) {
    throw new TestmailApiError(
      "TESTMAIL_NAMESPACE required to allocate an inbox; set it in .env or pass via opts.namespace"
    );
  }
  const tag = `barnacle-${randomUUID().slice(0, 8)}`;
  const address = `${namespace}.${tag}@inbox.testmail.app`;
  const timestampFrom = Date.now();
  logger.info(`allocated testmail inbox ${address} (timestampFrom=${timestampFrom})`);
  return { address, tag, timestampFrom };
}

/**
 * Build the singleton GraphQL client. Lazily initialised so the module
 * import doesn't fail when TESTMAIL_API_KEY isn't set (the helpers
 * themselves throw a clear error when called without config).
 */
let cachedClient:
  | ((operationName: string, query: string, variables: Record<string, unknown>) => Promise<unknown>)
  | null = null;

function getTestmailClient(): (
  operationName: string,
  query: string,
  variables: Record<string, unknown>
) => Promise<unknown> {
  if (cachedClient) return cachedClient;
  const apiKey = config.testmail.apiKey;
  if (!apiKey) {
    throw new TestmailApiError("TESTMAIL_API_KEY required to query testmail.app; set it in .env");
  }
  const bottleneck = new Bottleneck({ minTime: TESTMAIL_MIN_TIME_MS });
  cachedClient = createGraphqlClient({
    schema: InboxQueryResponseSchema,
    bottleneck,
    baseHeaders: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    endpoint: TESTMAIL_ENDPOINT,
  }) as (
    operationName: string,
    query: string,
    variables: Record<string, unknown>
  ) => Promise<unknown>;
  return cachedClient;
}

/** Reset the cached client. Useful when tests swap config between cases. */
export function resetTestmailClientForTests(): void {
  cachedClient = null;
}

const INBOX_QUERY = `
  query Inbox($namespace: String!, $tag: String, $timestampFrom: Float, $livequery: Boolean) {
    inbox(namespace: $namespace, tag: $tag, timestamp_from: $timestampFrom, livequery: $livequery) {
      result
      message
      count
      emails {
        id
        from
        subject
        text
        html
        date
      }
    }
  }
`;

/**
 * Poll the testmail.app inbox until a matching message arrives or the wait
 * budget runs out. Uses testmail's `livequery: true` for server-side long-
 * polling (cuts the round-trip count vs. tight client-side polling) but
 * also wraps in a client-side retry loop so a transient query failure
 * doesn't fail the whole wait.
 *
 * Throws `TestmailTimeoutError` on budget expiry. Throws `TestmailApiError`
 * when the API returns a non-success `result` field that doesn't recover
 * across iterations.
 */
export async function pollTestmailInbox(opts: PollTestmailInboxOptions): Promise<TestmailMessage> {
  const {
    inbox,
    subjectContains,
    timeoutMs = DEFAULT_POLL_TIMEOUT_MS,
    intervalMs = DEFAULT_POLL_INTERVAL_MS,
  } = opts;
  const namespace = config.testmail.namespace;
  if (!namespace) {
    throw new TestmailApiError("TESTMAIL_NAMESPACE required to poll an inbox; set it in .env");
  }
  const client = getTestmailClient();
  const deadline = Date.now() + timeoutMs;
  const subjectNeedle = subjectContains?.toLowerCase();
  let lastApiError: TestmailApiError | null = null;

  while (Date.now() < deadline) {
    let response: z.infer<typeof InboxQueryResponseSchema>;
    try {
      response = (await client("Inbox", INBOX_QUERY, {
        namespace,
        tag: inbox.tag,
        timestampFrom: inbox.timestampFrom,
        livequery: true,
      })) as z.infer<typeof InboxQueryResponseSchema>;
    } catch (err) {
      // Transient API failure — sleep + try again until deadline. Hold the
      // last error so a budget expiry can report something useful.
      lastApiError = new TestmailApiError(
        `inbox query failed: ${err instanceof Error ? err.message : String(err)}`
      );
      logger.warn(`testmail inbox query failed; retrying: ${lastApiError.message}`);
      await sleep(Math.min(intervalMs, deadline - Date.now()));
      continue;
    }

    const inboxData = response.data.inbox;
    if (inboxData.result !== "success") {
      lastApiError = new TestmailApiError(
        `inbox query returned result=${inboxData.result} message=${inboxData.message ?? "<null>"}`
      );
      logger.warn(`testmail inbox non-success result: ${lastApiError.message}`);
      await sleep(Math.min(intervalMs, deadline - Date.now()));
      continue;
    }

    const matching = inboxData.emails.find((email) => {
      if (!subjectNeedle) return true;
      return email.subject.toLowerCase().includes(subjectNeedle);
    });
    if (matching) {
      logger.info(
        `testmail inbox ${inbox.address} received matching message (subject="${matching.subject}", id=${matching.id})`
      );
      return {
        id: matching.id,
        from: matching.from,
        subject: matching.subject,
        text: matching.text ?? null,
        html: matching.html ?? null,
        date: matching.date,
      };
    }

    await sleep(Math.min(intervalMs, deadline - Date.now()));
  }

  const reason = lastApiError ? ` (last API error: ${lastApiError.message})` : "";
  throw new TestmailTimeoutError(
    `testmail inbox ${inbox.address} did not receive ${
      subjectContains ? `a message with subject containing "${subjectContains}"` : "any message"
    } within ${timeoutMs}ms${reason}`
  );
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
