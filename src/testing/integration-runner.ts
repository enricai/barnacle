/**
 * Site-agnostic scaffold for integration tests that submit via a plugin and
 * verify success by polling a testmail.app inbox. Each integration test owns
 * its per-job payload mapping; this module owns the orchestration that is
 * identical across every site: allocate inbox → build context → dispatch →
 * poll → return.
 */

import { config } from "@/config";
import { MetricsCollector } from "@/lib/dispatch-metrics";
import { getLogger } from "@/lib/logging";
import { dispatch } from "@/plugins/loader";
import type { SitePlugin, SitePluginResult } from "@/site-plugin";
import {
  allocateTestmailInbox,
  type PollTestmailInboxOptions,
  pollTestmailInbox,
  type TestmailInbox,
  type TestmailMessage,
} from "@/testmail/client";

const DEFAULT_POLL_TIMEOUT_MS = 120_000;

/**
 * Options accepted by `runIntegrationJob`. The payload builder is the only
 * per-site concern — everything else (inbox allocation, context construction,
 * dispatch, poll) is generic.
 */
export interface IntegrationJobOptions {
  /**
   * The plugin under test. Cast via `as SitePlugin<unknown, unknown>` at the
   * call site when the payload type is site-specific.
   */
  plugin: SitePlugin<unknown, unknown>;
  /**
   * Called with the freshly allocated testmail inbox so the caller can embed
   * `inbox.address` in the site-specific payload fields (e.g. `Email`,
   * `ContactEmailAddress`). Returns the complete payload to pass to dispatch.
   */
  buildPayload: (inbox: TestmailInbox) => unknown;
  /**
   * The `baseUrl` injected into the plugin context. Typically `job.baseUrl`
   * from the replay-jobs fixture.
   */
  baseUrl: string;
  /** Total wait budget passed to `pollTestmailInbox`. Default 120_000 ms. */
  pollTimeoutMs?: number;
  /** Optional subject filter passed to `pollTestmailInbox`. Omit to accept any message. */
  pollSubjectContains?: string;
  /**
   * Override for inbox allocation options (e.g. `namespace` in tests that
   * stub testmail without a real TESTMAIL_NAMESPACE in env).
   */
  inboxOptions?: Parameters<typeof allocateTestmailInbox>[0];
  /**
   * Override the `pollTestmailInbox` implementation. Injected by unit tests
   * to avoid real network calls.
   */
  pollFn?: (opts: PollTestmailInboxOptions) => Promise<TestmailMessage>;
}

/** Combined return value so callers can inspect both the dispatch result and the inbox message. */
export interface IntegrationJobResult<TResult> {
  result: SitePluginResult<TResult>;
  message: TestmailMessage;
}

/**
 * Runs one integration-test job end-to-end. Allocates a testmail inbox,
 * delegates payload construction to `buildPayload`, dispatches the plugin,
 * and polls for a confirmation email — returning both the dispatch result and
 * the received message so callers can make assertions on either.
 *
 * Throws when dispatch rejects or when the inbox poll times out (via
 * `TestmailTimeoutError`).
 */
export async function runIntegrationJob<TResult = Record<string, unknown>>(
  opts: IntegrationJobOptions
): Promise<IntegrationJobResult<TResult>> {
  const {
    plugin,
    buildPayload,
    baseUrl,
    pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS,
    pollSubjectContains,
    inboxOptions,
    pollFn = pollTestmailInbox,
  } = opts;

  const logger = getLogger({ name: `integration/${plugin.meta.siteId}` });
  const inbox = allocateTestmailInbox(inboxOptions);
  const payload = buildPayload(inbox);

  const context = {
    baseUrl,
    logger,
    config,
    requestId: "integration-test",
    metricsCollector: new MetricsCollector(),
  };

  const result = await dispatch<TResult>(plugin, payload, context);

  const message = await pollFn({
    inbox,
    timeoutMs: pollTimeoutMs,
    ...(pollSubjectContains ? { subjectContains: pollSubjectContains } : {}),
  });

  return { result, message };
}
