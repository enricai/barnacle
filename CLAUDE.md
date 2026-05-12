# Development Guidelines & Standards

**This document contains mandatory development standards referenced by all code in this project.**

All contributors must follow these patterns and rules. Code reviews will reference sections in this document.

---

## Build/Lint/Test Commands
- Build: `pnpm run build` (NODE_ENV=production)
- Dev: `pnpm run dev` (NODE_ENV=development, Turbopack enabled)
- Lint: `pnpm run lint` or `pnpm run lint:fix` (Biome)
- Format: `pnpm run format` (Biome)
- Tests: `pnpm run test` (Vitest)
- E2E Tests: `pnpm run test:e2e` (Playwright)
- Scripts: `pnpm run script -- path/to/script.ts`
- Clean: `pnpm run clean`

## MANDATORY Requirements

### IMPORTANT: Core TypeScript Rules

**MUST use TypeScript strict mode with explicit function return types (no `any`)**
```typescript
export async function validateUser(email: string): Promise<ValidationResult> {
// NOT: export async function validateUser(email: string) {
```

**MUST use double quotes and semicolons (Biome enforced)**
```typescript
const message = "Hello world";
// NOT: const message = 'Hello world'
```

**MUST use `@/` alias for imports from src directory**
**NEVER use relative imports for src files (`../../lib` -> `@/lib`)**
```typescript
import { getLogger } from "@/lib/logging";
// NOT: import { getLogger } from "../../lib/logging";
```

### IMPORTANT: Logging Rules

**ALWAYS use proper logger - NEVER console**
```typescript
const logger = getLoggerFromFilename({ filename: __filename });
// NOT: console.log("Starting process");
```

**ALWAYS start log entries with lowercase, exceptions with uppercase**
```typescript
logger.info("starting authentication process");
logger.error("AuthenticationError: invalid credentials");
// NOT: logger.info("Starting authentication process");
```

**ALWAYS use string interpolation for logging**
```typescript
logger.info(`user: ${user.email}, attempts: ${attempts}`);
// NOT: logger.info("user", { email: user.email, attempts });
```

### IMPORTANT: Code Style

**NEVER add whitespace to empty lines (leading or trailing)**

**NEVER add superfluous comments**

**ALWAYS organize imports: builtin, external, internal, relative (alphabetical)**
```typescript
import * as fs from "fs";
import { format } from "date-fns";
import { getLogger } from "@/lib/logging";
import { validateEmail } from "./validation";
```

**NEVER use `let` - it is a code smell indicating refactoring is needed**

Simple reassignment: use ternary with `const`
```typescript
const status = isDone ? "complete" : "pending";
```

Conditional fallback: use nullish coalescing with `const`
```typescript
const job = await getByInstanceId(id) ?? await getByTenantId(id);
```

Complex logic: extract to function that returns value
```typescript
const { token, refreshed } = await getTokenWithRefreshStatus(condition, cached);
```

**NEVER use `let` in loops - use functional array methods with `const` instead**
```typescript
for (const [i, result] of event.results.slice(event.resultIndex).entries())
// NOT: for (let i = event.resultIndex; i < event.results.length; i++)
```

**ALWAYS use early returns and guard clauses for validation and error handling**

**ALWAYS use async/await over Promises**
```typescript
const user = await db.user.findUnique({ where: { id } });
// NOT: db.user.findUnique({ where: { id } }).then(user => { ... });
```

**Arrow functions for callbacks, regular function declarations for exports**
```typescript
export async function processUsers(): Promise<void> {
  const users = await getUsers();
  users.forEach(user => sendEmail(user));
}
```

**ALWAYS use DRY (Don't Repeat Yourself) - extract repeated logic into reusable functions**

### IMPORTANT: Naming Conventions

**Variables/functions: camelCase, Types/interfaces: PascalCase, Constants: ALL_CAPS**
```typescript
const userEmail = "test@example.com";
const MAX_LOGIN_ATTEMPTS = 5;
interface UserProfile { ... }
type AuthResult = { ... };
```

**Files: flat names with directory hierarchy (NOT camelCase/snake_case)**
```typescript
./src/lib/auth/email.ts
// NOT: ./src/lib/emailAuth.ts
// NOT: ./src/lib/email-auth.ts
```

**NEVER create generic "utils" or "utility" modules**
**ALWAYS name modules by their specific functionality or domain**
```typescript
./src/lib/string/formatting.ts
./src/lib/validation/email.ts
./src/lib/date/conversion.ts
// NOT: ./src/lib/utils.ts
```

### IMPORTANT: Framework & Libraries

**MUST use date-fns for date manipulation (NOT `Date.now()` or `new Date()` directly)**
```typescript
import { formatISO, parseISO, addDays } from "date-fns";
import { toZonedTime, formatInTimeZone } from "date-fns-tz";

const timestamp = formatISO(new Date());
const parsed = parseISO("2026-01-05T12:00:00Z");
const futureDate = addDays(new Date(), 7);
// NOT: const timestamp = new Date().toISOString();
```

**MUST use lodash utilities when available (`isEmpty`, `omit`, `cloneDeep`)**
```typescript
import { isEmpty, omit, cloneDeep } from "lodash";
if (isEmpty(user.errors)) { ... }
const sanitized = omit(user, ["password", "token"]);
const copy = cloneDeep(originalData);
```

### IMPORTANT: Type Definitions

**Create types under `/src/types` folder**
```typescript
./src/types/auth.ts
./src/types/jobs.ts
```

**NEVER create nested interfaces**
**ALWAYS use explicit return types**
```typescript
interface User { id: string; profile: UserProfile; }
interface UserProfile { name: string; email: string; }
```

### IMPORTANT: Function Documentation

**MUST use TSDoc/JSDoc comments for all exported functions**
```typescript
/**
 * Validates user credentials and returns authentication result.
 *
 * @param email - User's email address
 * @param password - User's password
 * @returns Authentication result with user data or error
 * @throws {AuthenticationError} When credentials are invalid
 */
export async function validateUser(email: string, password: string): Promise<AuthResult> {
  // implementation
}
```

### IMPORTANT: UI & Responsiveness

**MUST ensure all components work on mobile, tablet, and desktop (responsive design)**
```typescript
<div className="flex flex-col md:flex-row lg:grid lg:grid-cols-3">
  <Card className="w-full md:w-1/2 lg:w-auto">...</Card>
</div>
```

## Next.js 16 Patterns
- App Router with React Server Components
- React Compiler enabled for automatic optimizations
- Turbopack for fast development builds
- Middleware for CSP, rate limiting
- Environment: Use environment helpers
- Server Actions for mutations

## Testing Standards
- **Unit tests**: Vitest with `.test.ts` extension
- **E2E tests**: Playwright with `.spec.ts` extension in `e2e/` directory
- **Test environment**: jsdom for React component testing
- **Coverage**: Auth flows, user management, API endpoints
- **Mocking**: External dependencies

## Task Completion Checklist
BEFORE marking ANY task complete:
1. Run `pnpm run lint:fix` - MUST pass with no errors
2. Run `pnpm run build` - MUST pass without errors
3. Run `pnpm run test` - relevant tests MUST pass
4. Verify `@/` alias usage for all src imports
5. Confirm TypeScript strict mode compliance (explicit return types)
6. Ensure responsive design (mobile/tablet/desktop)
7. Confirm TSDoc/JSDoc documentation for all exported functions
