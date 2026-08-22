# Barnacle Testing Guide

> Quick reference for writing and running tests. Coding standards:
> [../CLAUDE.md](../CLAUDE.md). Architecture: [architecture.md](./architecture.md).

## Running tests

```bash
pnpm run test                           # run all tests
pnpm test src/scraper/fixtures.test.ts  # single file (NEVER use -- before the filter)
pnpm run test:watch                     # re-run on file changes (dev loop)
pnpm run test:coverage                  # run tests with v8 coverage report
pnpm run typecheck                      # strict TypeScript (no emit) — run before every PR
pnpm run lint:fix                       # Biome lint + format — run before every PR
```

[Vitest](https://vitest.dev/), Node environment (no DOM), `@vitest/coverage-v8`. Timeout: 30s. Workers: up to 50% of CPUs (`pool: "forks"`).

## File conventions

- **Location:** colocated (`src/scraper/retry.ts` → `retry.test.ts`).
- **Naming:** `describe` matches the module/behavior; `it` describes the assertion.
- **Imports:** `@/` alias, same as source files.

```ts
import { describe, expect, it, vi } from "vitest";
import { withScraperRetry } from "@/scraper/retry";
```

## Unit tests

Pure functions, error classification, config parsing, no external deps.

```ts
// src/scraper/retry.test.ts (excerpt)
import { describe, expect, it } from "vitest";
import { classifyScraperError } from "@/scraper/retry";
import { CaptchaError, SessionTimeoutError } from "@/scraper/errors";

describe("classifyScraperError", () => {
  it("recognises 'captcha' in the message", () => {
    expect(classifyScraperError(new Error("captcha required"))).toBeInstanceOf(CaptchaError);
  });

  it("recognises 'timed out' in the message", () => {
    expect(classifyScraperError(new Error("operation timed out"))).toBeInstanceOf(
      SessionTimeoutError
    );
  });
});
```

## Route tests (no port binding)

`app.inject()` fires HTTP requests without binding a TCP port.

```ts
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { healthRoutes } from "@/api/routes/health";

async function buildApp() {
  const app = Fastify();
  await app.register(healthRoutes, {
    config: {
      scraper: {
        steelApiKey: "test-key",
        anthropicApiKey: "test-key",
        readinessQueueThreshold: 20,
        useBedrock: false,
      },
      bedrock: { accessKeyId: undefined, secretAccessKey: undefined, region: "us-east-1" },
    },
    poolStats: () => ({ size: 0, pending: 0, concurrency: 3 }),
    cacheStats: () => ({ size: 0, max: 1000, inFlight: 0 }),
  });
  await app.ready();
  return app;
}

describe("GET /healthz", () => {
  it("returns 200 + {status: 'ok'}", async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({ method: "GET", url: "/healthz" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "ok" });
    } finally {
      await app.close();
    }
  });
});
```

**Pattern:** build → inject → assert → close. Always `close()` in `finally`.

## Mocking external dependencies

`vi.mock` at module level; `vi.hoisted` for references the mock factory closes over.

```ts
// vi.hoisted runs before vi.mock — required when the mock factory uses
// the returned reference in its closure.
const mockCaptureSubmissionEnvelope = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined)
);

vi.mock("@/lib/telemetry/submission-capture", () => ({
  captureSubmissionEnvelope: mockCaptureSubmissionEnvelope,
}));

vi.mock("@/scraper/pool", () => ({
  runWithSession: vi.fn().mockImplementation(
    (task: (session: null) => Promise<unknown>) => task(null)
  ),
}));
```

See `loader.test.ts` for the full `dispatch()` pattern: pool, sink, metrics, and cache mocked; dispatch logic un-mocked.

## Testing out-of-tree plugins

Full load→register→dispatch path via a `.js` fixture under `__fixtures__/`.

```ts
import path from "node:path";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import authPlugin from "@/api/plugins/auth";
import errorHandlerPlugin from "@/api/plugins/error-handler";
import type { AppConfig } from "@/config";
import { getLogger } from "@/lib/logging";
import { loadPlugins } from "@/plugins/discover";
import { registerRoutes } from "@/plugins/loader";

vi.mock("@/scraper/pool", () => ({
  runWithSession: vi.fn().mockImplementation((task: (s: null) => Promise<unknown>) => task(null)),
}));
vi.mock("@/lib/telemetry/submission-capture", () => ({
  captureSubmissionEnvelope: vi.fn().mockResolvedValue(undefined),
}));

const FIXTURE_PATH = path.join(__dirname, "__fixtures__", "my-plugin.js");
const cfgStub = { scraper: { siteBaseUrls: {} } } as unknown as AppConfig;

it("serves POST /v1/<siteId>/run with the canned response", async () => {
  const { plugins } = await loadPlugins([FIXTURE_PATH], {
    baseDir: process.cwd(),
    strict: false,
    seenSiteIds: new Set(),
  });

  const app = Fastify({ loggerInstance: getLogger({ name: "test" }) });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorHandlerPlugin);
  await app.register(authPlugin);
  await registerRoutes(app, cfgStub, plugins);
  await app.ready();

  const response = await app.inject({ method: "POST", url: "/v1/my-plugin/run", payload: { query: "test" } });
  expect(response.statusCode).toBe(200);
  await app.close();
});
```

Set `DEV_BYPASS_AUTH=true` + `NODE_ENV=test` in `beforeEach`/`afterEach`. Fixture must be CJS (`module.exports = plugin`) — see `e2e-plugin.js`.

## Testing a new site plugin

1. **Hot path** — mock `createHttpClient`/`createGraphqlClient`, assert `executeHttp` result.
2. **Browser fallback** — mock `runWithSession`, assert `execute()` result.
3. **`auditPayload`** — assert only intended fields (no PII).
4. **`onRetry`** — assert `ScraperError` + attempt number per retry, if implemented.
5. **Telemetry** — for join keys discovered mid-run, stub `context.telemetry` and assert `addJoinKeys`.

**Mock the wrapper, not the factory.** Both return a **plain callable
function** — not an object with method names.

```ts
// Example: testing a new plugin's hot path
import * as graphqlClientModule from "@/scraper/graphql-client";

const fakeClient = vi.fn().mockResolvedValue({
  data: { items: [{ id: "1", name: "Widget" }] },
});
vi.spyOn(graphqlClientModule, "createGraphqlClient").mockReturnValue(
  fakeClient as never
);

it("hot path returns items from the GraphQL response", async () => {
  const result = await mySitePlugin.executeHttp!(
    { query: "widget" },
    { baseUrl: "https://my-site.com", logger: mockLogger, config: mockConfig }
  );
  // `result.data` is SitePluginResult.data; the inner `.data.items` is the
  // GraphQL response envelope returned by the wrapper.
  expect(result.data.data.items).toHaveLength(1);
  expect(result.data.data.items[0]?.id).toBe("1");
});
```

**Stub `context.telemetry`, not a module.** Assert on `addJoinKeys` directly.

```ts
// Example: asserting a mid-run join-key attachment
const addJoinKeys = vi.fn();
const stubContext = {
  baseUrl: "https://my-site.com",
  logger: mockLogger,
  config: mockConfig,
  requestId: "req-test-123",
  metricsCollector: mockMetricsCollector,
  recordBeaconOutcome: vi.fn().mockResolvedValue(undefined),
  telemetry: { addJoinKeys },
} as unknown as SitePluginContext;

it("attaches the confirmation token discovered mid-run as a join key", async () => {
  const session = makeSession();
  await mySitePlugin.execute({ query: "widget" }, session, stubContext);

  expect(addJoinKeys).toHaveBeenCalledWith({ confirmationToken: "abc123" });
});
```

Use `as unknown as SitePluginContext`, not a direct annotation (avoids excess-property checks).

## Integration-test scaffold

`runIntegrationJob` (`src/testing/integration-runner.ts`) polls a [testmail.app](https://testmail.app) inbox; per-plugin tests own only the payload mapping.

```ts
import { runIntegrationJob } from "@/testing/integration-runner";
import { myPlugin } from "@/sites/my-site";

const { result, message } = await runIntegrationJob({
  plugin: myPlugin as SitePlugin<unknown, unknown>,
  baseUrl: "https://my-site.com",
  buildPayload: (inbox) => ({ Email: inbox.address, JobId: "42" }),
  pollTimeoutMs: 120_000,
});

expect(message.subject).toBeTruthy();
```

Pass a stub `pollFn` in unit tests — see `integration-runner.test.ts`.

## Batch-test harness

`runBatchEmailConfirmation` (`src/testing/batch-email-confirmation.ts`): phase 1 submits jobs, phase 2 polls serially. Site behaviour is callback-injected.

```ts
import { runBatchEmailConfirmation } from "@/testing/batch-email-confirmation";

const verdicts = await runBatchEmailConfirmation(jobs, {
  allocateInbox: () => allocateTestmailInbox(),
  submit: async (job, inbox) => { /* returns SubmitOutcome */ },
  pollEmail: async (inbox) => { /* returns PollOutcome */ },
  mapVerdict: (job, submitOutcome, pollOutcome) => ({ ... }),
  concurrency: 3,
});
```

`renderBatchReport` (`src/testing/batch-report.ts`) renders verdicts as a markdown table with a `Net: N/M` summary line.

## Shared test fixtures

`resume-fixture.ts` / `persona-fixture.ts` export the canonical test persona and resume.

- `loadTestResume()` — reads `resume.pdf`, returns `buffer`/`contentType`/`filename`/`base64`.
- `resumePayloadFields(resume)` — maps to the four shared resume payload fields.
- `TEST_PERSONA` — static contact fields (name/phone/address).

```ts
import { loadTestResume, resumePayloadFields } from "@/testing/resume-fixture";
import { TEST_PERSONA } from "@/testing/persona-fixture";

const resume = loadTestResume();
const payload = {
  Email: "test@example.com",
  FirstName: TEST_PERSONA.FirstName,
  ...resumePayloadFields(resume),
};
```

## Structural coverage guard

`defineCoverageGuardSuite` (`src/testing/coverage-guard-suite.ts`) asserts each registered plugin has a `contract.parity.test.ts`, without hardcoding site names.

```ts
import { defineCoverageGuardSuite } from "@/testing/coverage-guard-suite";
import { BUILTIN_SITE_PLUGINS } from "@/plugins/discover";
import { resolve } from "node:path";

defineCoverageGuardSuite({
  suiteName: "plugin structural coverage guard",
  plugins: BUILTIN_SITE_PLUGINS,
  sitesDir: resolve(__dirname, "../sites"),
});
```

Pass a stub `{ meta: { siteId } }` array in unit tests. Live guard: `src/sites/_shared/coverage-expectations.test.ts`.

## Coverage exclusions

Excluded from coverage (see `vitest.config.ts`):

| Exclusion | Reason |
|-----------|--------|
| `src/**/*.d.ts` | TypeScript declaration files — no executable code |
| `src/**/*.test.ts` | Test files themselves |
| `src/types/**` | Interface files — no executable code |
| `src/scraper/session.ts` | Requires a live browser session (Browserbase/Steel) to test meaningfully |
| `src/server.ts` | Fastify entrypoint — `main()` only fires when executed directly |

## Task completion checklist

See CLAUDE.md's "Task Completion Checklist" for the steps required before marking any task done.
