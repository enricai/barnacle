import { readFileSync } from "node:fs";
import path from "node:path";
import Browserbase from "@browserbasehq/sdk";
import { describe, expect, it } from "vitest";

import { configureHttpDispatcher } from "@/lib/http";

describe("configureHttpDispatcher", () => {
  it("strips the explicit content-length header Browserbase's SDK would otherwise set", () => {
    configureHttpDispatcher();

    const apiClientPrototype = Object.getPrototypeOf(Browserbase.prototype) as {
      buildHeaders: (args: Record<string, unknown>) => Record<string, string>;
    };
    const fakeClient = {
      defaultHeaders: () => ({}),
      validateHeaders: () => {},
    };

    const headers = apiClientPrototype.buildHeaders.call(fakeClient, {
      options: {},
      headers: {},
      contentLength: "52",
      retryCount: 0,
    });

    expect(headers["content-length"]).toBeUndefined();
  });

  it("is idempotent across repeated calls", () => {
    configureHttpDispatcher();
    configureHttpDispatcher();

    const apiClientPrototype = Object.getPrototypeOf(Browserbase.prototype) as {
      buildHeaders: (args: Record<string, unknown>) => Record<string, string>;
    };
    const fakeClient = {
      defaultHeaders: () => ({}),
      validateHeaders: () => {},
    };

    const headers = apiClientPrototype.buildHeaders.call(fakeClient, {
      options: {},
      headers: {},
      contentLength: "52",
      retryCount: 0,
    });

    expect(headers["content-length"]).toBeUndefined();
  });
});

/**
 * Consumers run their own entry points — scripts, probes, batch jobs — and each
 * one must call {@link configureHttpDispatcher} for the same reason `server.ts`
 * does. Until this subpath was exported they could not: the `exports` map made
 * `@enricai/barnacle/lib/http` unresolvable, so every consumer script silently
 * ran on a transport where the Browserbase SDK's release call fails and every
 * `keepAlive` session it created billed to its own timeout. Keep it exported.
 */
describe("lib/http is reachable by consumers", () => {
  const rootDir = path.resolve(__dirname, "..", "..");
  const packageJson = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf-8")) as {
    exports: Record<string, { types: string; default: string }>;
  };

  it("is declared in package.json's exports map", () => {
    expect(packageJson.exports["./lib/http"]).toEqual({
      types: "./dist/lib/http.d.ts",
      default: "./dist/lib/http.js",
    });
  });
});

/**
 * Pins the mechanism the comment in `lib/http.ts` describes, because it is
 * surprising enough that a future reader may otherwise "fix" the explanation.
 * `globalThis.fetch` stays Node's bundled undici, but importing the installed
 * undici writes a `Dispatcher1Wrapper` into the legacy `undici.globalDispatcher.1`
 * global that the bundled copy reads — which is how an import alone changes what
 * the Browserbase SDK's `globalThis.fetch` call dispatches into.
 */
describe("importing undici redirects the bundled fetch's dispatcher", () => {
  it("populates the legacy global dispatcher slot the bundled undici reads", async () => {
    await import("undici");

    const slots = Object.getOwnPropertySymbols(globalThis)
      .map(String)
      .filter((name) => name.includes("undici.globalDispatcher"));

    expect(slots).toContain("Symbol(undici.globalDispatcher.1)");
  });
});
