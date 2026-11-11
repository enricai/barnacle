import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { sendReplay } from "@/scripts/recon-http";

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

describe("sendReplay redirects", () => {
  it("re-issues a POST with method, body and headers after a 301", async () => {
    const seen: Array<{ method?: string; url?: string; body: string; ct?: string }> = [];
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, body, ct: req.headers["content-type"] });
        if (req.url === "/api") {
          res.writeHead(301, { location: "/en/api" }).end();
        } else {
          res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
        }
      });
    });
    await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    const out = await sendReplay(
      {
        url: `http://127.0.0.1:${port}/api`,
        method: "POST",
      } as Parameters<typeof sendReplay>[0],
      { "content-type": "application/json" },
      '{"a":1}'
    );
    expect(out.response.status).toBe(200);
    expect(out.body).toEqual({ ok: true });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({
      method: "POST",
      url: "/en/api",
      body: '{"a":1}',
      ct: "application/json",
    });
  });
});
