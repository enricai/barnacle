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
