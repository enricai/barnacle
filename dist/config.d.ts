/**
 * Fully resolved, strongly typed application config derived from environment
 * variables at process start. Consumers import the `config` singleton instead
 * of reading `process.env` directly so that required vars are validated once.
 */
export interface AppConfig {
    appName: string;
    nodeEnv: "development" | "production" | "test";
    host: string;
    port: number;
    logLevel: string;
    databaseUrl: string | undefined;
    auth: {
        hashedKeys: readonly string[];
        devBypass: boolean;
    };
    /**
     * Whether Fastify trusts inbound `X-Forwarded-For` / `X-Forwarded-Proto`.
     * True is correct when Barnacle runs behind a reverse proxy (ALB, nginx,
     * Cloudflare). False is required when deployed directly to the internet
     * — otherwise clients can spoof `X-Forwarded-For` to bypass rate
     * limiting, since the rate-limit key falls back to `request.ip` for
     * unauthenticated traffic.
     */
    trustProxy: boolean;
    scraper: {
        /**
         * Default browser-session provider. Browserbase is the default because
         * Stagehand v3's payload-injection upload path is gated on
         * `env === "BROWSERBASE"` and several other code paths (CDP timeouts,
         * session recovery, event-window timing) only activate in that mode.
         * Steel remains a supported fallback via `SCRAPER_PROVIDER=steel` or the
         * `--provider steel` CLI flag.
         */
        provider: "browserbase" | "steel";
        browserbaseApiKey: string | undefined;
        browserbaseProjectId: string | undefined;
        steelApiKey: string | undefined;
        anthropicApiKey: string | undefined;
        model: string;
        proxyType: string;
        solveCaptcha: boolean;
        poolSize: number;
        minActionDelayMs: number;
        maxActionDelayMs: number;
        readinessQueueThreshold: number;
        /**
         * Per-site base URL overrides keyed by `meta.siteId`. Populated at startup
         * from `BARNACLE_SITE_<UPPERCASE_SITE_ID>_BASE_URL` env vars — underscores
         * in the env key map to hyphens in the siteId. Example:
         * `BARNACLE_SITE_MY_SHOP_BASE_URL=https://staging.my-shop.com` overrides
         * the `my-shop` plugin's `defaultBaseUrl` without any source change.
         * Falls back to `SitePluginMeta.defaultBaseUrl` when the key is absent.
         */
        siteBaseUrls: Record<string, string>;
        /** Master switch: routes Stagehand LLM calls through AWS Bedrock when true. */
        useBedrock: boolean;
        /** Anthropic SDK request timeout in ms. Raise for slow network paths to api.anthropic.com. */
        anthropicTimeoutMs: number;
        /** TCP connect timeout for all outbound fetch calls. Undici default is 10 s; raised to 120 s to match anthropicTimeoutMs. */
        connectTimeoutMs: number;
        /** Steel session wall-clock timeout in ms. Default is 1 hour; lower via STEEL_SESSION_TIMEOUT_MS on plans with shorter limits. */
        steelSessionTimeoutMs: number;
    };
    bedrock: {
        region: string;
        accessKeyId: string | undefined;
        secretAccessKey: string | undefined;
        sessionToken: string | undefined;
        model: string;
    };
    cache: {
        ttlMs: number;
        maxEntries: number;
    };
    rateLimit: {
        max: number;
        windowMs: number;
    };
    docs: {
        enabled: boolean;
    };
    telemetry: {
        /**
         * Master switch — set to false to disable all NDJSON telemetry writes.
         * Useful for environments where the disk path is unavailable or I/O is
         * cost-sensitive; the capture sink checks this before every append.
         */
        enabled: boolean;
        /**
         * Directory that holds per-run NDJSON event stream files. The event-writer
         * creates `<eventsDir>/<runId>.ndjson` at session start. Default matches
         * the `.barnacle/events` path referenced in run-state.ts so operator docs
         * and `.gitignore` stay consistent.
         */
        eventsDir: string;
        /**
         * Absolute or cwd-relative path for the append-only NDJSON file that
         * records one line per LLM/Stagehand call. Feed this to the judge and
         * self-heal skills. Default keeps it alongside the event-stream files.
         */
        callsNdjsonPath: string;
        /**
         * Rotate / drop the calls NDJSON once it exceeds this byte count.
         * Guards against unbounded disk growth on long-running deployments.
         * Default is 100 MB.
         */
        maxFileSizeBytes: number;
        /**
         * Drop event-stream files older than this many milliseconds. Default is
         * 30 days — long enough for a monthly judge/heal cadence.
         */
        maxRetentionMs: number;
    };
    judging: {
        /**
         * Anthropic model used by the judge script to score captured call samples.
         * Defaults to the Bedrock cross-region inference profile so it reuses the
         * scraper's AWS creds without a separate billing account.
         */
        model: string;
        /**
         * Sampling temperature for judge LLM calls. Lower values (≤ 0.3) produce
         * more deterministic verdicts; raise only for exploratory runs.
         */
        temperature: number;
        /**
         * Number of call samples sent to the judge in one LLM request. Larger
         * batches reduce round-trips but increase per-call token cost.
         */
        batchSize: number;
        /**
         * Anthropic SDK request timeout for judge calls in ms. Judge batches are
         * larger than scraper calls so a longer timeout is warranted.
         */
        timeoutMs: number;
    };
    /**
     * testmail.app — fresh inboxes for recon runs + integration tests.
     * Both fields nullable so a missing API key doesn't break unrelated
     * config loads; the testmail helpers throw clear errors when called
     * without configuration.
     */
    testmail: {
        /** `TESTMAIL_API_KEY` — get from https://testmail.app/console */
        apiKey: string | undefined;
        /** `TESTMAIL_NAMESPACE` — the subdomain piece (e.g. "abc12" for `abc12.{tag}@inbox.testmail.app`). */
        namespace: string | undefined;
    };
    selfheal: {
        /**
         * Maximum patch→replay→score iterations before giving up with
         * BUDGET_EXHAUSTED. Mirrors the recon-heal default of 5.
         */
        maxIterations: number;
        /**
         * Number of replay runs per iteration arm. Replays are cheap (no browser),
         * so a higher n gives a more stable pass-rate estimate.
         */
        nReplays: number;
        /**
         * Minimum pass rate (0..1) to declare SUCCESS and stop iterating.
         * Mirrors the pila llm-self-heal SKILL default of 0.9.
         */
        successThreshold: number;
        /**
         * Consecutive iterations whose pass-rate improvement is below
         * `plateauDelta` that triggers a PLATEAUED verdict. Mirrors recon-heal.
         */
        plateauWindow: number;
        /**
         * Minimum absolute improvement in pass rate between iterations to be
         * considered meaningful progress; below this the run plateaus.
         */
        plateauDelta: number;
        /**
         * Per-replay LLM request timeout in ms. Patch replay calls are small
         * single-turn requests so a tighter timeout keeps the loop fast.
         */
        timeoutMs: number;
    };
}
/**
 * Loads and validates the application config. Call this once at process
 * startup; subsequent calls return the same frozen object.
 */
export declare function loadConfig(): AppConfig;
export declare const config: AppConfig;
