import { Writable } from "node:stream";

import Fastify, { type FastifyBaseLogger } from "fastify";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import { buildLoggerOptions, extendLogger } from "@/lib/logging";
import type { Logger } from "@/types/logging";

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

type LogLine = Record<string, unknown>;

/**
 * Builds a Fastify app on the project's real logger wiring, writing at info
 * level into `lines`. `getLogger` is forced silent under NODE_ENV=test, so the
 * options are rebuilt here with the level overridden.
 */
async function buildLoggedApp(lines: LogLine[]): Promise<ReturnType<typeof Fastify>> {
  const sink = new Writable({
    write(chunk, _enc, cb): void {
      lines.push(
        ...String(chunk)
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      );
      cb();
    },
  });
  const logger = extendLogger(
    pino({ ...buildLoggerOptions({ name: "test" }), level: "info", transport: undefined }, sink)
  );
  const app = Fastify({ loggerInstance: logger as FastifyBaseLogger });
  app.get("/probe", async (request) => {
    request.log = request.log.child({ fingerprint: "fp1" });
    request.log.info("handled probe");
    (request.log as Logger).errorWithStack(new Error("boom"), "probe failed");
    return { seen: request.headers.authorization };
  });
  await app.ready();
  return app;
}

describe("logger on Fastify request children", () => {
  it("leaves the Authorization header intact and out of every log line", async () => {
    const lines: LogLine[] = [];
    const app = await buildLoggedApp(lines);

    const response = await app.inject({
      method: "GET",
      url: "/probe",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    await app.close();

    expect(response.json()).toEqual({ seen: `Bearer ${TOKEN}` });
    expect(JSON.stringify(lines)).not.toContain(TOKEN);
  });

  it("logs the compact request, not the raw one", async () => {
    const lines: LogLine[] = [];
    const app = await buildLoggedApp(lines);

    await app.inject({
      method: "GET",
      url: "/probe",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    await app.close();

    const incoming = lines.find((line) => line.msg === "incoming request");
    expect(incoming?.req).toMatchObject({ method: "GET", url: "/probe" });
    expect(incoming?.req).not.toHaveProperty("raw");
  });

  it("keeps the request and child bindings on request.log and errorWithStack", async () => {
    const lines: LogLine[] = [];
    const app = await buildLoggedApp(lines);

    await app.inject({ method: "GET", url: "/probe" });
    await app.close();

    const handled = lines.find((line) => line.msg === "handled probe");
    const failed = lines.find((line) => String(line.msg).startsWith("probe failed"));
    expect(handled).toMatchObject({ fingerprint: "fp1" });
    expect(handled?.reqId).toBeDefined();
    expect(failed).toMatchObject({ fingerprint: "fp1" });
    expect(failed?.reqId).toBeDefined();
  });
});

describe("logger service field", () => {
  const preserved = process.env.DD_SERVICE;

  afterEach(() => {
    if (preserved === undefined) delete process.env.DD_SERVICE;
    else process.env.DD_SERVICE = preserved;
  });

  it("writes the DD_SERVICE service on every emitted line for Datadog", () => {
    process.env.DD_SERVICE = "cruiselines";
    const lines: LogLine[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb): void {
        lines.push(JSON.parse(String(chunk)));
        cb();
      },
    });
    const logger = pino(
      { ...buildLoggerOptions({ name: "test" }), level: "info", transport: undefined },
      sink
    );

    logger.info("starting");

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ service: "cruiselines", msg: "starting" });
  });

  it("writes the level uppercase so the shared Datadog @level:ERROR monitor matches", () => {
    const lines: LogLine[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb): void {
        lines.push(JSON.parse(String(chunk)));
        cb();
      },
    });
    const logger = pino(
      { ...buildLoggerOptions({ name: "test" }), level: "info", transport: undefined },
      sink
    );

    logger.info("starting");
    logger.error("failed");

    expect(lines.map((line) => line.level)).toEqual(["INFO", "ERROR"]);
  });
});
