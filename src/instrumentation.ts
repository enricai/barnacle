/**
 * Next.js instrumentation file for runtime initialization.
 *
 * This file is called during server startup to initialize
 * observability tools like Pino logging before handling requests.
 *
 * @see https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Initialize Pino logger for Node.js runtime
    await import("pino");
  }
}
