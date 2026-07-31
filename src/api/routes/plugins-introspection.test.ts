import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import authPlugin from "@/api/plugins/auth";
import errorHandlerPlugin from "@/api/plugins/error-handler";
import {
  type PluginsIntrospectionOptions,
  pluginsIntrospectionRoutes,
} from "@/api/routes/plugins-introspection";
import type { PluginLoadRecord } from "@/plugins/discover";

/**
 * Route tests for GET /v1/plugins. Auth is exercised via real authPlugin
 * registration, injecting env vars the same way auth.test.ts does — avoids
 * mocking the auth internals while keeping tests hermetic.
 *
 * The plugin load report is injected through options (mirrors HealthRoutesOptions)
 * so tests can assert the exact payload without full app wiring.
 */

const VALID_KEY = "test-key-for-plugins-route-99";

const SAMPLE_REPORT: PluginLoadRecord[] = [
  {
    siteId: "acme",
    displayName: "Acme Site",
    specifier: "(builtin)",
    resolvedPath: null,
    route: "/v1/acme/run",
    apiVersion: null,
    status: "loaded",
  },
  {
    siteId: null,
    displayName: null,
    specifier: "./missing-plugin.js",
    resolvedPath: null,
    route: null,
    apiVersion: null,
    status: "disabled",
    reason: "cannot resolve plugin specifier",
  },
];

async function buildApp(options: PluginsIntrospectionOptions): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify();
  await app.register(errorHandlerPlugin);
  await app.register(authPlugin);
  await app.register(pluginsIntrospectionRoutes, options);
  await app.ready();
  return app;
}

describe("routes/plugins-introspection GET /v1/plugins", () => {
  const preserved = {
    API_KEYS_HASHED: process.env.API_KEYS_HASHED,
    DEV_BYPASS_AUTH: process.env.DEV_BYPASS_AUTH,
    NODE_ENV: process.env.NODE_ENV,
  };

  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    // Use a fast bcrypt cost factor so tests don't time out. Same approach
    // as auth.test.ts — bcryptjs accepts low cost values for testing.
    const bcrypt = await import("bcryptjs");
    const hash = await bcrypt.hash(VALID_KEY, 4);
    process.env.API_KEYS_HASHED = hash;
    delete process.env.DEV_BYPASS_AUTH;
    process.env.NODE_ENV = "test";

    app = await buildApp({ report: SAMPLE_REPORT });
  });

  afterEach(async () => {
    await app.close();
    if (preserved.API_KEYS_HASHED === undefined) delete process.env.API_KEYS_HASHED;
    else process.env.API_KEYS_HASHED = preserved.API_KEYS_HASHED;
    if (preserved.DEV_BYPASS_AUTH === undefined) delete process.env.DEV_BYPASS_AUTH;
    else process.env.DEV_BYPASS_AUTH = preserved.DEV_BYPASS_AUTH;
    if (preserved.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = preserved.NODE_ENV;
  });

  it("returns 200 with the injected report for an authenticated request", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/plugins",
      headers: { authorization: `Bearer ${VALID_KEY}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as PluginLoadRecord[];
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
    expect(body[0]).toMatchObject({
      siteId: "acme",
      displayName: "Acme Site",
      specifier: "(builtin)",
      resolvedPath: null,
      route: "/v1/acme/run",
      apiVersion: null,
      status: "loaded",
    });
    expect(body[1]).toMatchObject({
      siteId: null,
      status: "disabled",
      reason: "cannot resolve plugin specifier",
    });
  });

  it("returns 401 without an Authorization header", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/plugins",
    });

    expect(response.statusCode).toBe(401);
  });

  it("returns 401 with an invalid Bearer token", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/plugins",
      headers: { authorization: "Bearer wrong-token-abc" },
    });

    expect(response.statusCode).toBe(401);
  });

  it("returns the exact report passed via options (injectable contract)", async () => {
    const customReport: PluginLoadRecord[] = [
      {
        siteId: "hello-site",
        displayName: "Hello Site",
        specifier: "./hello-site/dist/index.js",
        resolvedPath: "/home/operator/hello-site/dist/index.js",
        route: "/v1/hello-site/run",
        apiVersion: "1.0.0",
        status: "loaded",
      },
    ];

    const customApp = await buildApp({ report: customReport });
    try {
      const response = await customApp.inject({
        method: "GET",
        url: "/v1/plugins",
        headers: { authorization: `Bearer ${VALID_KEY}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as PluginLoadRecord[];
      expect(body).toHaveLength(1);
      expect(body[0]).toMatchObject({
        siteId: "hello-site",
        resolvedPath: "/home/operator/hello-site/dist/index.js",
        apiVersion: "1.0.0",
        status: "loaded",
      });
    } finally {
      await customApp.close();
    }
  });

  it("returns an empty array when the report is empty", async () => {
    const emptyApp = await buildApp({ report: [] });
    try {
      const response = await emptyApp.inject({
        method: "GET",
        url: "/v1/plugins",
        headers: { authorization: `Bearer ${VALID_KEY}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([]);
    } finally {
      await emptyApp.close();
    }
  });

  it("returns 200 without auth header when DEV_BYPASS_AUTH=true in non-production", async () => {
    process.env.DEV_BYPASS_AUTH = "true";
    process.env.NODE_ENV = "development";
    const bypassApp = await buildApp({ report: SAMPLE_REPORT });
    try {
      const response = await bypassApp.inject({
        method: "GET",
        url: "/v1/plugins",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as PluginLoadRecord[];
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(2);
    } finally {
      await bypassApp.close();
    }
  });
});
