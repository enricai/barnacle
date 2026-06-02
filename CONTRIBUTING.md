# Contributing to Barnacle

Thanks for your interest in contributing. Barnacle is MIT-licensed; by submitting a pull request you agree that your contribution is provided under the same license (inbound = outbound).

## Prerequisites

- Node.js `>= 22` (see `.nvmrc`)
- pnpm `>= 10`
- A Postgres database for local development

## Setup

```bash
pnpm install
cp .env.example .env   # then fill in the required values
pnpm run db:push       # apply the Prisma schema
```

## Dev loop

```bash
pnpm run dev           # tsx watch
```

## Before opening a pull request

All three must pass:

```bash
pnpm run lint:fix
pnpm run typecheck
pnpm run test
```

Coding standards (TypeScript strict mode, Pino logging, `@/` import alias, response envelope shape, etc.) are documented in [`CLAUDE.md`](./CLAUDE.md) — please read it before sending a non-trivial change.

## Filing issues

Bug reports and feature requests are welcome at https://github.com/enricai/barnacle/issues. For bugs, include reproduction steps and the relevant log output (Barnacle uses Pino — JSON in prod, pretty in dev).
