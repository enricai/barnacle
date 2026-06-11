"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.allocateTestmailInbox = allocateTestmailInbox;
exports.resetTestmailClientForTests = resetTestmailClientForTests;
exports.pollTestmailInbox = pollTestmailInbox;
const node_crypto_1 = require("node:crypto");
const bottleneck_1 = __importDefault(require("bottleneck"));
const v4_1 = require("zod/v4");
const config_1 = require("../config");
const logging_1 = require("../lib/logging");
const graphql_client_1 = require("../scraper/graphql-client");
const errors_1 = require("../testmail/errors");
const logger = (0, logging_1.getLogger)({ name: "testmail/client" });
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
const InboxQueryResponseSchema = v4_1.z.object({
    data: v4_1.z.object({
        inbox: v4_1.z.object({
            result: v4_1.z.string(),
            message: v4_1.z.string().nullable().optional(),
            count: v4_1.z.number(),
            emails: v4_1.z.array(v4_1.z.object({
                id: v4_1.z.string(),
                from: v4_1.z.string(),
                subject: v4_1.z.string(),
                text: v4_1.z.string().nullable().optional(),
                html: v4_1.z.string().nullable().optional(),
                date: v4_1.z.number(),
            })),
        }),
    }),
});
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
function allocateTestmailInbox(opts = {}) {
    const namespace = opts.namespace ?? config_1.config.testmail.namespace;
    if (!namespace) {
        throw new errors_1.TestmailApiError("TESTMAIL_NAMESPACE required to allocate an inbox; set it in .env or pass via opts.namespace");
    }
    const tag = `barnacle-${(0, node_crypto_1.randomUUID)().slice(0, 8)}`;
    const address = `${namespace}.${tag}@inbox.testmail.app`;
    const timestampFrom = Date.now();
    logger.info(`allocated testmail inbox ${address} (timestampFrom=${timestampFrom})`);
    return { address, tag, timestampFrom };
}
let cachedClient = null;
function getTestmailClient() {
    if (cachedClient)
        return cachedClient;
    const apiKey = config_1.config.testmail.apiKey;
    if (!apiKey) {
        throw new errors_1.TestmailApiError("TESTMAIL_API_KEY required to query testmail.app; set it in .env");
    }
    const bottleneck = new bottleneck_1.default({ minTime: TESTMAIL_MIN_TIME_MS });
    cachedClient = (0, graphql_client_1.createGraphqlClient)({
        schema: InboxQueryResponseSchema,
        bottleneck,
        baseHeaders: {
            "Content-Type": "application/json",
            Accept: "application/json",
            Authorization: `Bearer ${apiKey}`,
        },
        endpoint: TESTMAIL_ENDPOINT,
    });
    return cachedClient;
}
/** Reset the cached client. Useful when tests swap config between cases. */
function resetTestmailClientForTests() {
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
async function pollTestmailInbox(opts) {
    const { inbox, subjectContains, timeoutMs = DEFAULT_POLL_TIMEOUT_MS, intervalMs = DEFAULT_POLL_INTERVAL_MS, } = opts;
    const namespace = config_1.config.testmail.namespace;
    if (!namespace) {
        throw new errors_1.TestmailApiError("TESTMAIL_NAMESPACE required to poll an inbox; set it in .env");
    }
    const client = getTestmailClient();
    const deadline = Date.now() + timeoutMs;
    const subjectNeedle = subjectContains?.toLowerCase();
    let lastApiError = null;
    while (Date.now() < deadline) {
        let response;
        try {
            // Bound the underlying fetch on the remaining deadline. testmail's
            // `livequery: true` long-polls server-side (the server holds the
            // connection open for ~15 min waiting for new mail), and Node's
            // built-in fetch has no default timeout — without this signal a
            // single query outlasts the caller's poll budget by many minutes.
            const remaining = deadline - Date.now();
            response = (await client("Inbox", INBOX_QUERY, {
                namespace,
                tag: inbox.tag,
                timestampFrom: inbox.timestampFrom,
                livequery: true,
            }, { signal: AbortSignal.timeout(remaining) }));
        }
        catch (err) {
            // Transient API failure — sleep + try again until deadline. Hold the
            // last error so a budget expiry can report something useful.
            lastApiError = new errors_1.TestmailApiError(`inbox query failed: ${err instanceof Error ? err.message : String(err)}`);
            logger.warn(`testmail inbox query failed; retrying: ${lastApiError.message}`);
            await sleep(Math.min(intervalMs, deadline - Date.now()));
            continue;
        }
        const inboxData = response.data.inbox;
        if (inboxData.result !== "success") {
            lastApiError = new errors_1.TestmailApiError(`inbox query returned result=${inboxData.result} message=${inboxData.message ?? "<null>"}`);
            logger.warn(`testmail inbox non-success result: ${lastApiError.message}`);
            await sleep(Math.min(intervalMs, deadline - Date.now()));
            continue;
        }
        const matching = inboxData.emails.find((email) => {
            if (!subjectNeedle)
                return true;
            return email.subject.toLowerCase().includes(subjectNeedle);
        });
        if (matching) {
            logger.info(`testmail inbox ${inbox.address} received matching message (subject="${matching.subject}", id=${matching.id})`);
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
    throw new errors_1.TestmailTimeoutError(`testmail inbox ${inbox.address} did not receive ${subjectContains ? `a message with subject containing "${subjectContains}"` : "any message"} within ${timeoutMs}ms${reason}`);
}
function sleep(ms) {
    if (ms <= 0)
        return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=client.js.map