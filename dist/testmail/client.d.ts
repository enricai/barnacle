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
export declare function allocateTestmailInbox(opts?: AllocateTestmailInboxOptions): TestmailInbox;
/** Reset the cached client. Useful when tests swap config between cases. */
export declare function resetTestmailClientForTests(): void;
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
export declare function pollTestmailInbox(opts: PollTestmailInboxOptions): Promise<TestmailMessage>;
