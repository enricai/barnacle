# Barnacle Testing Guide

> Quick reference for writing and running tests. For coding standards, see
> [../CLAUDE.md](../CLAUDE.md). For architecture context, see
> [architecture.md](./architecture.md).

---

## Running tests

```bash
pnpm run test              # run all tests
pnpm run test:watch        # re-run on file changes (dev loop)
pnpm run test:coverage     # run tests with v8 coverage report
pnpm run typecheck         # strict TypeScript (no emit) — run before every PR
pnpm run lint:fix          # Biome lint + format — run before every PR
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
      databaseUrl: undefined,
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

External dependencies (Prisma, Steel session pool, metrics counters) must be
mocked so tests run without live infrastructure. Use `vi.mock` at the module
level and `vi.hoisted` for references that mock factories close over.

```ts
// vi.hoisted runs before vi.mock — required when the mock factory uses
// the returned reference in its closure.
const mockCreate = vi.hoisted(() => vi.fn().mockResolvedValue({ id: "stub-id" }));

vi.mock("@/lib/db/client", () => ({
  prisma: {
    siteSubmission: { create: mockCreate },
    $disconnect: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/scraper/pool", () => ({
  runWithSession: vi.fn().mockImplementation(
    (task: (session: null) => Promise<unknown>) => task(null)
  ),
}));
```

The `loader.test.ts` file shows the full pattern for testing `dispatch()` —
mocking the pool, Prisma, metrics, and cache while keeping the dispatch logic
itself un-mocked.

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

```ts
// Example: testing a new plugin's hot path
vi.mock("@/scraper/graphql-client", () => ({
  createGraphqlClient: () => vi.fn().mockResolvedValue({
    data: { items: [{ id: "1", name: "Widget" }] },
  }),
}));

it("hot path returns items from the GraphQL response", async () => {
  const result = await mySitePlugin.executeHttp!(
    { query: "widget" },
    { baseUrl: "https://my-site.com", logger: mockLogger, config: mockConfig }
  );
  expect(result.data.data.items).toHaveLength(1);
  expect(result.data.data.items[0]?.id).toBe("1");
});
```

---

## Coverage exclusions

The following are excluded from coverage reports (see `vitest.config.ts`):

| Exclusion | Reason |
|-----------|--------|
| `src/**/*.d.ts` | TypeScript declaration files — no executable code |
| `src/**/*.test.ts` | Test files themselves |
| `src/generated/**` | Prisma-generated client — regenerated by `db:generate` |
| `src/types/**` | Interface files — no executable code |
| `src/scraper/session.ts` | Requires a live Steel session to test meaningfully |
| `src/server.ts` | Fastify entrypoint — `main()` only fires when executed directly |

---

## Task completion checklist (from CLAUDE.md)

Before marking any task done:

1. `pnpm run lint:fix` — must pass with no errors
2. `pnpm run typecheck` — must pass
3. `pnpm run test` — relevant tests must pass
4. Verify `@/` alias usage on all src imports
5. Confirm explicit return types on all exported functions
6. Confirm TSDoc on all exported functions (explain *why*, not *what*)
