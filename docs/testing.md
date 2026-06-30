# Barnacle Testing Guide

> Quick reference for writing and running tests. For coding standards, see
> [../CLAUDE.md](../CLAUDE.md). For architecture context, see
> [architecture.md](./architecture.md).

---

## Running tests

```bash
pnpm run test                           # run all tests
pnpm test src/scraper/fixtures.test.ts  # single file (NEVER use -- before the filter)
pnpm run test:watch                     # re-run on file changes (dev loop)
pnpm run test:coverage                  # run tests with v8 coverage report
pnpm run typecheck                      # strict TypeScript (no emit) — run before every PR
pnpm run lint:fix                       # Biome lint + format — run before every PR
```

Tests use [Vitest](https://vitest.dev/) in Node environment (no DOM). Coverage
uses `@vitest/coverage-v8`. Timeout: 30 seconds per test. Workers: up to 50% of
available CPUs (`pool: "forks"`).

---

## File conventions

- **Test file location:** colocated with the module being tested.
  `src/scraper/retry.ts` → `src/scraper/retry.test.ts`
- **Naming:** `describe` blocks mirror the module name or the behavior under
  test; `it` strings describe what the test asserts, not how it does it.
- **Imports:** use `@/` alias, matching the convention enforced for source files.

```ts
import { describe, expect, it, vi } from "vitest";
import { withScraperRetry } from "@/scraper/retry";
```

---

## Unit tests

Unit tests cover pure functions, error classification, config parsing, and
utilities that have no external dependencies.

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

---

## Route tests (no port binding)

Route tests use Fastify's `app.inject()` to fire HTTP requests directly into
the Fastify instance without binding a TCP port. This avoids port conflicts
and is faster than a real HTTP round-trip.

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

**Pattern:** build → inject → assert → close. Always `close()` in `finally` to
avoid open-handle leaks between tests.

---

## Mocking external dependencies

External dependencies (the submission-envelope sink, Steel session pool, metrics counters) must be
mocked so tests run without live infrastructure. Use `vi.mock` at the module
level and `vi.hoisted` for references that mock factories close over.

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

The `loader.test.ts` file shows the full pattern for testing `dispatch()` —
mocking the pool, the submission-envelope sink, metrics, and cache while
keeping the dispatch logic itself un-mocked.

---

## Testing a new site plugin

A new plugin needs tests for:

1. **Hot path returns data** — mock `createHttpClient` or `createGraphqlClient`
   to return a fixture response and assert the plugin's `executeHttp` returns
   the right `SitePluginResult`.
2. **Browser fallback is wired** — mock `runWithSession` to call the task with
   a stub session and assert `execute()` returns the right `SitePluginResult`.
3. **`auditPayload` is set correctly** — assert `result.auditPayload` contains
   only the fields you intend to write to the DB (no PII, right shape).
4. **`onRetry` hook** — if your plugin implements `onRetry`, assert it is called
   with the correct `ScraperError` and attempt number on each retry cycle.

**Mock the wrapper, not the factory.** Plugins call `createHttpClient()` (or
`createGraphqlClient()`) once at module scope and reuse the returned wrapper
inside `executeHttp`. Both factories return a **plain callable function**, not
an object with method names — `createHttpClient` returns
`(url, init) => Promise<TResponse>` (`src/scraper/http-client.ts:103-105`);
`createGraphqlClient` returns
`(operationName, query, variables) => Promise<TResponse>`
(`src/scraper/graphql-client.ts:28-34`). Your mock must be a callable with the
same signature. Mocking the factory but leaving the return as an object with
imagined `.query` / `.get` methods produces a wrapper that's called as a
function but resolves to `undefined` — the test fails confusingly inside
`executeHttp` rather than at the mock boundary.

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

---

## Integration-test scaffold

`src/testing/integration-runner.ts` exports `runIntegrationJob` — a
site-agnostic orchestrator for end-to-end integration tests that verify a
plugin submission by polling a [testmail.app](https://testmail.app) inbox.

Each plugin's integration test owns only the per-job payload mapping; the
generic steps (inbox allocation, context construction, `dispatch()`, inbox
poll) live in the helper:

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

In unit tests, pass a stub `pollFn` to avoid real network calls — see
`src/testing/integration-runner.test.ts` for the full pattern.

---

## Batch-test harness

`src/testing/batch-email-confirmation.ts` exports `runBatchEmailConfirmation` — a
site-agnostic two-phase batch runner used by scripts that submit many jobs and
then verify each one via a confirmation email. Phase 1 submits all jobs (with
configurable concurrency via `p-queue`); phase 2 polls each inbox serially to
stay within testmail's rate limit.

All site-specific behaviour is injected via callbacks (`allocateInbox`,
`submit`, `pollEmail`, `mapVerdict`), so the harness owns only the loop:

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

`src/testing/batch-report.ts` exports `renderBatchReport` — a pure function
that converts a `BatchJobVerdict[]` into a markdown table with a `Net: N/M`
summary line. Callers decide how to emit the string (stdout, file, logger).

---

## Shared test fixtures

`src/testing/resume-fixture.ts` and `src/testing/persona-fixture.ts` export the
canonical test persona and resume used across all site tests so every test submits
the same data and a future swap is a one-file change.

- `loadTestResume()` — reads `src/testing/fixtures/resume.pdf` and returns a
  `TestResume` with `buffer`, `contentType`, `filename`, and `base64` fields.
- `resumePayloadFields(resume)` — maps a `TestResume` to the four payload field
  names every resume-accepting site shares (`Resume`, `ResumeContentType`,
  `ResumeFilename`, `ResumeBase64`). Spread into the payload object instead of
  repeating the mapping at every call site.
- `TEST_PERSONA` — a static `PersonaFixture` object with pre-filled applicant
  contact fields (name, phone, address) sourced from `persona-fixture.ts`.

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

---

## Structural coverage guard

`src/testing/coverage-guard-suite.ts` exports `defineCoverageGuardSuite` — a
registry-driven helper that asserts each registered plugin has a co-located
`contract.parity.test.ts` without hardcoding any site name. On `main` where
`SITE_PLUGINS` is empty the guard runs zero iterations (trivially green); any
branch that populates the registry gains the check automatically.

```ts
import { defineCoverageGuardSuite } from "@/testing/coverage-guard-suite";
import { SITE_PLUGINS } from "@/plugins/loader";
import { resolve } from "node:path";

defineCoverageGuardSuite({
  suiteName: "plugin structural coverage guard",
  plugins: SITE_PLUGINS,
  sitesDir: resolve(__dirname, "../sites"),
});
```

Pass a stub array of `{ meta: { siteId } }` objects in unit tests — no real
plugin imports needed. The optional `extraAssertions(pluginDir, siteId)` callback
lets callers register additional per-plugin `it` blocks (replay fixture presence,
etc.) without baking site-specific logic into the engine helper.

The live cross-plugin guard for the site branch lives in
`src/sites/_shared/coverage-expectations.test.ts`. It drives
`defineCoverageGuardSuite` with the real `SITE_PLUGINS` registry, locks the
replay-fixture asymmetry, and pins per-plugin bodySchema rejection baselines —
keeping `src/testing/contract-parity-suite.test.ts` free of site imports.

---

## Coverage exclusions

The following are excluded from coverage reports (see `vitest.config.ts`):

| Exclusion | Reason |
|-----------|--------|
| `src/**/*.d.ts` | TypeScript declaration files — no executable code |
| `src/**/*.test.ts` | Test files themselves |
| `src/types/**` | Interface files — no executable code |
| `src/scraper/session.ts` | Requires a live Steel session to test meaningfully |
| `src/server.ts` | Fastify entrypoint — `main()` only fires when executed directly |

---

## Task completion checklist (from CLAUDE.md)

Before marking any task done:

1. `pnpm run lint:fix` — must pass with no errors
2. `pnpm run typecheck` — must pass
3. `pnpm test <relevant-file>` — relevant tests must pass (NEVER use `--` before the filter)
4. Verify `@/` alias usage on all src imports
5. Confirm explicit return types on all exported functions
6. Confirm TSDoc on all exported functions (explain *why*, not *what*)
