# App Template

A modern Next.js 16 base template with TypeScript, Tailwind CSS v4, Vitest, and Playwright testing.

## Getting Started

### Prerequisites

- Node.js 22+
- pnpm 10.4.1

### Installation

```bash
pnpm install
```

### Development

```bash
pnpm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Build

```bash
pnpm run build
```

### Production Server

```bash
pnpm run start
```

### Clean

```bash
pnpm run clean    # Remove node_modules, dist, .next
```

### Linting

```bash
pnpm run lint        # Check for violations
pnpm run lint:fix    # Auto-fix violations
```

### Testing

```bash
pnpm run test           # Run unit tests
pnpm run test:watch     # Run unit tests in watch mode
pnpm run test:e2e       # Run E2E tests
pnpm run test:e2e:ui    # Run E2E tests with UI
```

## Project Structure

```
src/
├── app/           # Next.js App Router pages
├── components/    # React components
├── lib/           # Utility functions and libraries
├── types/         # TypeScript type definitions
└── tests/         # Test files
    └── mocks/     # Test mocks
```

## Development Guidelines

See [CLAUDE.md](./CLAUDE.md) for coding standards and conventions.

## Key Features

- **Next.js 16** with App Router and React Compiler
- **TypeScript** with strict mode
- **Tailwind CSS v4** for styling
- **Biome** for linting and formatting (10-25x faster than ESLint)
- **Turbopack** for fast development builds
- **shadcn/ui** for accessible UI components
- **Pino** for production-grade logging (CloudWatch compatible)
- **Prisma 7** ORM with driver adapters
- **next-intl** for internationalization (i18n)
- **date-fns** for date manipulation
- **Vitest** for unit testing
- **Playwright** for E2E testing
- **Husky** for git hooks
