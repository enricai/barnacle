import http from "node:http";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import requestContextPlugin from "@/api/plugins/request-context";

/**
 * Request-context handles three invariants that observability depends on:
 *   1. Inbound X-Request-ID is respected so traces stitch across services.
 *   2. When no X-Request-ID is present, we generate one (Fastify would
 *      generate a bare `req-N` otherwise — nanoid gives a cross-process
 *      unique ID).
 *   3. X-Correlation-ID is echoed only when the caller sent it — we
 *      never invent one, since correlation IDs are a caller concern.
 */

async function buildApp(): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify();
  await app.register(requestContextPlugin);
  app.get("/ping", async (request) => ({
    id: request.id,
    correlationId: request.correlationId,
  }));
  await app.ready();
  return app;
}

describe("api/plugins/request-context", () => {
  it("echoes a supplied x-request-id on the response and uses it as the request id", async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/ping",
        headers: { "x-request-id": "trace-abc-123" },
      });
      expect(response.headers["x-request-id"]).toBe("trace-abc-123");
      const body = response.json() as { id: string };
      expect(body.id).toBe("trace-abc-123");
    } finally {
      await app.close();
    }
  });

  it("generates a fresh request id when none is supplied", async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({ method: "GET", url: "/ping" });
      const id = response.headers["x-request-id"];
      expect(typeof id).toBe("string");
      expect((id as string).length).toBeGreaterThan(8);
    } finally {
      await app.close();
    }
  });

  it("echoes x-correlation-id only when the caller provides it", async () => {
    const app = await buildApp();
    try {
      const withCorrelation = await app.inject({
        method: "GET",
        url: "/ping",
        headers: { "x-correlation-id": "corr-xyz" },
      });
      expect(withCorrelation.headers["x-correlation-id"]).toBe("corr-xyz");

      const withoutCorrelation = await app.inject({ method: "GET", url: "/ping" });
      expect(withoutCorrelation.headers["x-correlation-id"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("ignores an empty-string x-request-id and generates a fresh one", async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/ping",
        headers: { "x-request-id": "" },
      });
      // Empty string is rejected; fastify's default id generator kicks in.
      const id = response.headers["x-request-id"];
      expect(id).not.toBe("");
      expect(id).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it("produces different request ids across calls when none is supplied", async () => {
    const app = await buildApp();
    try {
      const [a, b] = await Promise.all([
        app.inject({ method: "GET", url: "/ping" }),
        app.inject({ method: "GET", url: "/ping" }),
      ]);
      expect(a.headers["x-request-id"]).not.toBe(b.headers["x-request-id"]);
    } finally {
      await app.close();
    }
  });

  it("rejects an inbound x-request-id containing CRLF (log-injection guard)", async () => {
    // An attacker might try: X-Request-ID: foo\r\nSet-Cookie: evil=1
    // Node generally strips header CRLFs but the value still lands in
    // our structured logs and gets echoed back. Reject anything outside
    // the trace-id charset and generate a fresh id instead.
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/ping",
        headers: { "x-request-id": "foo\r\nSet-Cookie: evil=1" },
      });
      const id = response.headers["x-request-id"] as string;
      expect(id).not.toContain("\r");
      expect(id).not.toContain("\n");
      expect(id).not.toContain("Set-Cookie");
    } finally {
      await app.close();
    }
  });

  it("rejects an absurdly long inbound x-request-id", async () => {
    // Keep trace-id values bounded so a malicious client can't inflate
    // log volume by sending 10 KB of junk as their request id.
    const app = await buildApp();
    try {
      const huge = "a".repeat(10_000);
      const response = await app.inject({
        method: "GET",
        url: "/ping",
        headers: { "x-request-id": huge },
      });
      const id = response.headers["x-request-id"] as string;
      expect(id).not.toBe(huge);
      expect(id.length).toBeLessThan(200);
    } finally {
      await app.close();
    }
  });

  it("rejects an inbound x-correlation-id with disallowed characters", async () => {
    // Correlation IDs get echoed back to the response verbatim; same
    // charset hardening as x-request-id.
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/ping",
        headers: { "x-correlation-id": "<script>alert(1)</script>" },
      });
      expect(response.headers["x-correlation-id"]).toBeUndefined();
      const body = response.json() as { correlationId?: string };
      expect(body.correlationId).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("accepts a well-formed W3C-style trace id (alphanumerics + `-._:`)", async () => {
    const app = await buildApp();
    try {
      const traceId = "0af7651916cd43dd.8448eb211c80319c";
      const response = await app.inject({
        method: "GET",
        url: "/ping",
        headers: { "x-request-id": traceId },
      });
      expect(response.headers["x-request-id"]).toBe(traceId);
    } finally {
      await app.close();
    }
  });

  it("logs one aborted:true line with the reqId when the client aborts mid-flight; none on normal completion", async () => {
    const lines: Array<Record<string, unknown>> = [];
    const app = Fastify({
      logger: {
        level: "info",
        stream: { write: (m: string) => lines.push(JSON.parse(m)) },
      },
    });
    await app.register(requestContextPlugin);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    app.get("/slow", async () => {
      await gate;
      return { ok: true };
    });
    app.get("/fast", async () => ({ ok: true }));
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;

    const ok = await app.inject({ method: "GET", url: "/fast" });
    expect(ok.statusCode).toBe(200);

    const req = http.get({
      host: "127.0.0.1",
      port,
      path: "/slow",
      headers: { "x-request-id": "abort-me-1" },
    });
    req.on("error", () => {});
    await new Promise((r) => setTimeout(r, 100));
    const closed = new Promise<void>((r) => req.on("close", () => r()));
    req.destroy();
    await closed;
    await new Promise((r) => setTimeout(r, 100));
    release();
    await app.close();

    const aborted = lines.filter((l) => l.aborted === true);
    expect(aborted).toHaveLength(1);
    expect(aborted[0]?.reqId).toBe("abort-me-1");
    expect(aborted[0]?.level).toBeLessThan(50);
  });

  it("logs no abort for a completed POST with a body over a real socket; exactly one when destroyed mid-flight", async () => {
    // app.inject has no socket, so it cannot see that IncomingMessage emits
    // "close" as soon as a fully-read body is consumed — long before the reply.
    const lines: Array<Record<string, unknown>> = [];
    const app = Fastify({
      logger: {
        level: "info",
        stream: { write: (m: string) => lines.push(JSON.parse(m)) },
      },
    });
    await app.register(requestContextPlugin);
    app.post("/work", async () => {
      await new Promise((r) => setTimeout(r, 100));
      return { ok: true };
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;
    const body = JSON.stringify({ hello: "world" });
    const post = (requestId: string): http.ClientRequest =>
      http.request({
        host: "127.0.0.1",
        port,
        path: "/work",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "x-request-id": requestId,
        },
      });

    try {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = post("complete-1");
        req.on("error", reject);
        req.on("response", (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        });
        req.end(body);
      });
      expect(status).toBe(200);
      expect(lines.filter((l) => l.aborted === true)).toHaveLength(0);

      const req = post("abort-me-2");
      req.on("error", () => {});
      req.end(body);
      await new Promise((r) => setTimeout(r, 50));
      const closed = new Promise<void>((r) => req.on("close", () => r()));
      req.destroy();
      await closed;
      await new Promise((r) => setTimeout(r, 150));
    } finally {
      await app.close();
    }

    const aborted = lines.filter((l) => l.aborted === true);
    expect(aborted).toHaveLength(1);
    expect(aborted[0]?.reqId).toBe("abort-me-2");
  });
});
