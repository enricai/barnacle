import type { IncomingMessage, ServerResponse } from "node:http";
import { buildServer } from "@/server";

/**
 * Vercel Node Function entry. Wraps the existing Fastify app so Vercel
 * owns the socket; we never call app.listen() in this path. The instance
 * is cached at module scope so warm invocations skip plugin registration.
 */
let appPromise: ReturnType<typeof buildServer> | null = null;

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!appPromise) {
    appPromise = buildServer();
  }
  const app = await appPromise;
  await app.ready();
  app.server.emit("request", req, res);
}
