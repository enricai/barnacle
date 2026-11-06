import { Writable } from "node:stream";

import Fastify, { type FastifyBaseLogger } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { z } from "zod/v4";

import { buildLoggerOptions, extendLogger } from "@/lib/logging";

type LogLine = Record<string, unknown>;

/**
 * Builds a logger on the project's real wiring, writing into `lines`.
 * `getLogger` is silent under NODE_ENV=test, so the level is overridden here.
 */
function buildSink(lines: LogLine[], raw: string[]): pino.Logger {
  const sink = new Writable({
    write(chunk, _enc, cb): void {
      for (const line of String(chunk).split("\n").filter(Boolean)) {
        raw.push(line);
        lines.push(JSON.parse(line));
      }
      cb();
    },
  });
  return pino(
    { ...buildLoggerOptions({ name: "test" }), level: "info", transport: undefined },
    sink
  );
}

function zodErrorWithIssues(count: number): z.ZodError {
  const Schema = z.object({
    options: z.object({ daysRange: z.array(z.object({ label: z.string() })) }),
  });
  const result = Schema.safeParse({
    options: { daysRange: Array.from({ length: count }, () => ({ label: null })) },
  });
  if (result.success) throw new Error("fixture should not parse");
  return result.error;
}

describe("logger err serializer caps validation issues", () => {
  it("truncates a 600-issue error and records the real total", () => {
    const lines: LogLine[] = [];
    const raw: string[] = [];
    buildSink(lines, raw).error({ err: zodErrorWithIssues(600) }, "unhandled error");

    const err = lines[0]?.err as { issues?: unknown[]; issuesTotal?: number };
    expect(err.issues).toHaveLength(10);
    expect(err.issuesTotal).toBe(600);
  });

  it("keeps the line far below CloudWatch's 256KB event cap", () => {
    // The regression: a 600-entry violation logged ~225KB as one line, which
    // arrives split across events and unreadable exactly when it is needed.
    const lines: LogLine[] = [];
    const raw: string[] = [];
    buildSink(lines, raw).error({ err: zodErrorWithIssues(600) }, "unhandled error");

    expect(raw.join("").length).toBeLessThan(10_000);
  });

  it("reads issues from `cause`, where a serializer failure carries them", async () => {
    // fastify-type-provider-zod wraps the ZodError in a
    // ResponseSerializationError and exposes it as `cause`, NOT as `issues` —
    // a serializer that only checks the top level is dead code for the one
    // case that matters.
    const lines: LogLine[] = [];
    const raw: string[] = [];
    const logger = extendLogger(buildSink(lines, raw));
    const app = Fastify({ loggerInstance: logger as unknown as FastifyBaseLogger });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.setErrorHandler((error, request, reply) => {
      request.log.error({ err: error }, "unhandled error");
      reply.code(500).send({});
    });
    app.post(
      "/s",
      {
        schema: {
          response: {
            200: z.object({
              options: z.object({ daysRange: z.array(z.object({ label: z.string() })) }),
            }),
          },
        },
      },
      async () => ({ options: { daysRange: Array.from({ length: 600 }, () => ({ label: null })) } })
    );
    await app.ready();
    await app.inject({ method: "POST", url: "/s", payload: {} });
    await app.close();

    const logged = lines.find((l) => l.msg === "unhandled error")?.err as {
      issuesTotal?: number;
      issues?: unknown[];
    };
    expect(logged?.issuesTotal).toBe(600);
    expect(logged?.issues).toHaveLength(10);
    expect(raw.join("").length).toBeLessThan(20_000);
  });

  it("leaves an ordinary error's shape intact", () => {
    const lines: LogLine[] = [];
    const raw: string[] = [];
    buildSink(lines, raw).error({ err: new Error("plain failure") }, "unhandled error");

    const err = lines[0]?.err as { message?: string; issues?: unknown; stack?: string };
    expect(err.message).toBe("plain failure");
    expect(err.issues).toBeUndefined();
    expect(err.stack).toBeTruthy();
  });
});
