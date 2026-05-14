# Development Guidelines & Standards

**This document contains mandatory development standards referenced by all code in this project.**

Barnacle is a headless Node.js API that automates FEMA disaster assistance
application submissions via Steel + Stagehand browser automation. All contributors
must follow these patterns and rules. Code reviews will reference sections in this document.

---

## Build/Lint/Test Commands

- Dev: `pnpm run dev` (NODE_ENV=development, tsx watch)
- Build: `pnpm run build` (NODE_ENV=production, tsc → dist/)
- Start: `pnpm start` (runs compiled dist/server.js)
- Lint: `pnpm run lint` or `pnpm run lint:fix` (Biome)
- Format: `pnpm run format` (Biome)
- Typecheck: `pnpm run typecheck` (tsc --noEmit)
- Tests: `pnpm run test` (Vitest)
- Clean: `pnpm run clean`

## MANDATORY Requirements

### IMPORTANT: Core TypeScript Rules

**MUST use TypeScript strict mode with explicit function return types (no `any`)**

```typescript
export async function validateUser(email: string): Promise<ValidationResult> {
// NOT: export async function validateUser(email: string) {
```

**MUST use double quotes and semicolons (Biome enforced)**

**MUST use `@/` alias for imports from src directory. NEVER use relative imports for src files (`../../lib` -> `@/lib`)**

### IMPORTANT: Logging Rules

**ALWAYS use the Pino logger — NEVER console**

```typescript
const logger = getLogger({ name: "scope-name" });
// NOT: console.log("Starting process");
```

**ALWAYS start log entries with lowercase, exceptions with uppercase**

```typescript
logger.info("starting authentication process");
logger.error("AuthenticationError: invalid credentials");
```

**ALWAYS use string interpolation for logging**

```typescript
logger.info(`user: ${user.email}, attempts: ${attempts}`);
```

### IMPORTANT: Code Style

- **NEVER** add whitespace to empty lines.
- **NEVER** add superfluous comments. Comments should explain *why*, not *what*.
- **ALWAYS** organize imports: builtin → external → internal (alphabetical inside each group).
- **AVOID** `let` for data — use `const` with ternary / nullish-coalescing / extracted helpers. `let` is acceptable for for-loop counters and small local state machines (parsers, accumulators) where mutation is the whole point.
- **ALWAYS** use early returns and guard clauses.
- **ALWAYS** use `async/await` over `.then()`.
- **DRY**: extract repeated logic into reusable functions.

### IMPORTANT: Naming Conventions

- Variables/functions: `camelCase`
- Types/interfaces: `PascalCase`
- Constants: `ALL_CAPS`
- Files: flat names with directory hierarchy (NOT camelCase, NOT snake_case)
- **NEVER** create generic `utils` or `utility` modules — name by domain.

### IMPORTANT: Framework & Libraries

**MUST use date-fns for date manipulation.** `new Date()` / `Date.now()` are allowed only at
system boundaries (Prisma timestamps, `dateTime` field emission).

### IMPORTANT: Type Definitions

**Create types under `/src/types` or derive them via `z.infer` from the Zod schemas
in `/src/api/schemas`.** Inferred types are preferred so the schema stays the
single source of truth.

### IMPORTANT: Function Documentation

**MUST use TSDoc/JSDoc comments for all exported functions** that describe *why*
they exist, not *what* they do. Short is fine — one or two sentences.

---

## Architectural Rules

### Battle-tested libraries only — do not reinvent

Barnacle deliberately avoids custom implementations of common concerns. When you
need one of these, use the listed library, not a hand-rolled alternative:

- HTTP server: **fastify** + `@fastify/helmet`, `@fastify/compress`, `@fastify/rate-limit`, `@fastify/swagger`
- Schema: **zod** via `fastify-type-provider-zod`
- Scraper: **@browserbasehq/stagehand** + **steel-sdk**
- Concurrency: **p-queue** (queues), **p-retry** (retries), **bottleneck** (throttling + jitter)
- Caching: **lru-cache**
- Logging: **pino** + **pino-pretty** (pino-pretty is the dev transport only; prod emits raw JSON)
- Hashing: **bcryptjs**
- Auth: bearer token via the custom `authPlugin` wired into Fastify

Do not add custom retry loops, concurrency queues, in-memory caches, request-id
plumbing, or security-header middleware. The frameworks own those concerns.

### Response envelope

Every response body MUST use the standard envelope shape:

```json
{
  "status": {
    "httpStatus": "...",
    "dateTime": "...",
    "details": [...]
  },
  "...": "..."
}
```

Error codes MUST come from `VPS_ERROR_CODES` in `src/api/schemas/common.ts`.
HTTP status codes are set by `httpStatusForCode()` — don't hard-code statuses.

### Tests

- **Unit tests**: Vitest, `.test.ts`, Node environment.
- **Route tests**: use `app.inject()` — no port binding.

## Task Completion Checklist

BEFORE marking ANY task complete:

1. `pnpm run lint:fix` — MUST pass with no errors.
2. `pnpm run typecheck` — MUST pass.
3. `pnpm run test` — relevant tests MUST pass.
4. Verify `@/` alias usage for all src imports.
5. Confirm TypeScript strict-mode compliance (explicit return types on exported functions).
6. Confirm TSDoc/JSDoc on all exported functions (explain *why*, not *what*).
