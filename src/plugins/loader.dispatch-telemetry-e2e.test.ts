/**
 * True end-to-end test of the HTTP → dispatch() → telemetry-sink chain: a
 * real Fastify app (via app.inject(), no port binding), a real dispatch()
 * call, and the REAL captureSubmissionEnvelope/captureBeaconEvent writers
 * appending to a real temp file on disk, read back with the real
 * readReconciliationRows. Every other suite mocks one half of this seam —
 * loader.test.ts mocks the telemetry writers (including its own
 * app.inject()-based tests); submission-reconciliation-roundtrip.test.ts
 * calls the writers directly, skipping Fastify/dispatch() entirely. This is
 * the one place both real layers are exercised together, so a wiring bug
 * that only manifests when the full chain runs (not just each piece in
 * isolation) would only surface here.
 *
 * Only @/config (for the sink path) and @/scraper/pool (so the test plugin
 * doesn't need a real Browserbase session) are mocked — dd-metrics and the
 * response cache are genuinely no-op/in-memory and safe to leave real.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

import authPlugin from "@/api/plugins/auth";
import errorHandlerPlugin from "@/api/plugins/error-handler";
import type { AppConfig } from "@/config";
import { getLogger } from "@/lib/logging";
import { readReconciliationRows } from "@/lib/telemetry/submission-reader";
import { registerRoutes } from "@/plugins/loader";
import type { SitePlugin, SitePluginResult } from "@/site-plugin";

let tmpDir: string;
let sinkPath: string;

// A placeholder sink path (plain string, no Node module access — vi.hoisted
// factories run before imports resolve) so eager top-level reads of `config`
// at module import time (e.g. response-cache.ts's
// `new LRUCache({max: config.cache...})`) don't blow up on an unset
// `sinkPath` — beforeEach mutates this ref before any request is dispatched,
// and the getter below reads it live on every access, so dispatch()'s later
// `config.telemetry.submissionsNdjsonPath` read sees the real per-test temp
// path. vi.hoisted is required (not a bare const) because vi.mock factories
// are hoisted above all other module code, including plain const
// declarations — vi.hoisted runs before that hoist.
const sinkPathRef = vi.hoisted(() => ({ current: "/tmp/dispatch-telemetry-e2e-unset.ndjson" }));

vi.mock("@/scraper/pool", () => ({
  runWithSession: vi.fn().mockImplementation((task: (s: null) => Promise<unknown>) => task(null)),
}));

vi.mock("@/config", async () => {
  const actual = await vi.importActual<typeof import("@/config")>("@/config");
  return {
    ...actual,
    get config() {
      return {
        ...actual.config,
        telemetry: { ...actual.config.telemetry, submissionsNdjsonPath: sinkPathRef.current },
      };
    },
  };
});

const cfgStub = { scraper: { siteBaseUrls: {} } } as unknown as AppConfig;

describe("dispatch() telemetry end-to-end: real HTTP request to real NDJSON sink", () => {
  const preservedEnv = {
    DEV_BYPASS_AUTH: process.env.DEV_BYPASS_AUTH,
    NODE_ENV: process.env.NODE_ENV,
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-telemetry-e2e-"));
    sinkPath = path.join(tmpDir, "submissions.ndjson");
    sinkPathRef.current = sinkPath;
    process.env.DEV_BYPASS_AUTH = "true";
    process.env.NODE_ENV = "development";
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (preservedEnv.DEV_BYPASS_AUTH === undefined) delete process.env.DEV_BYPASS_AUTH;
    else process.env.DEV_BYPASS_AUTH = preservedEnv.DEV_BYPASS_AUTH;
    if (preservedEnv.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = preservedEnv.NODE_ENV;
    vi.clearAllMocks();
  });

  it("preserves a real TrackingUrl on the skipped beacon record when a plugin with extractJoinKeys is dispatched over real HTTP", async () => {
    const trackingUrl = "https://click.e2e-test.example/t/abc?vivclid=e2e-123&empId=emp1&jid=jid1";

    const joinKeysPlugin: SitePlugin<unknown, unknown> = {
      extractJoinKeys: (payload) => {
        const { TrackingUrl } = payload as { TrackingUrl?: string };
        return TrackingUrl ? { vivclid: "e2e-123", jobReference: "emp1_jid1" } : null;
      },
      meta: {
        siteId: "e2e-test",
        displayName: "E2E Test",
        bodySchema: z.object({ TrackingUrl: z.string().optional() }),
        responseSchema: z.object({ verified: z.boolean() }),
      },
      execute: vi.fn(),
      executeHttp: async (): Promise<SitePluginResult<unknown>> => ({
        data: { verified: true },
      }),
    };

    const app = Fastify({ loggerInstance: getLogger({ name: "dispatch-telemetry-e2e-test" }) });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(errorHandlerPlugin);
    await app.register(authPlugin);
    await registerRoutes(app, cfgStub, [joinKeysPlugin]);
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/v1/e2e-test/run",
      payload: { TrackingUrl: trackingUrl },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().verified).toBe(true);

    await app.close();

    const rows = await readReconciliationRows({ sinkPath });
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.siteId).toBe("e2e-test");
    expect(row?.status).toBe("submitted");
    expect(row?.joinKeys).toEqual({ vivclid: "e2e-123", jobReference: "emp1_jid1" });
    expect(row?.beaconStatus).toBe("skipped");
    expect(row?.beaconTrackingUrl).toBe(trackingUrl);
  });

  it("folds a plugin's self-recorded fired beacon over the engine's own skipped beacon, dispatched over real HTTP", async () => {
    const trackingUrl =
      "https://click.e2e-test.example/t/self-managed?vivclid=e2e-456&empId=emp2&jid=jid2";
    const joinKeys = { vivclid: "e2e-456", jobReference: "emp2_jid2" };

    const selfRecordingPlugin: SitePlugin<unknown, unknown> = {
      extractJoinKeys: (payload) => {
        const { TrackingUrl } = payload as { TrackingUrl?: string };
        return TrackingUrl ? joinKeys : null;
      },
      meta: {
        siteId: "e2e-self-recording",
        displayName: "E2E Self Recording",
        bodySchema: z.object({ TrackingUrl: z.string().optional() }),
        responseSchema: z.object({ verified: z.boolean() }),
      },
      execute: vi.fn(),
      executeHttp: async (_payload, context): Promise<SitePluginResult<unknown>> => {
        await context.recordBeaconOutcome({
          beaconStatus: "fired",
          joinKeys,
          trackingUrl,
          durationMs: 42,
        });
        return { data: { verified: true } };
      },
    };

    const app = Fastify({ loggerInstance: getLogger({ name: "dispatch-telemetry-e2e-test" }) });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(errorHandlerPlugin);
    await app.register(authPlugin);
    await registerRoutes(app, cfgStub, [selfRecordingPlugin]);
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/v1/e2e-self-recording/run",
      payload: { TrackingUrl: trackingUrl },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().verified).toBe(true);

    await app.close();

    const rawLines = fs
      .readFileSync(sinkPath, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { kind: string; beaconStatus?: string });
    const beaconLines = rawLines.filter((line) => line.kind === "beacon");
    expect(beaconLines).toHaveLength(2);
    // The plugin's `fired` write happens inside executeHttp, before
    // runPluginPipeline returns; the engine's `skipped` write happens after
    // (loader.ts's emitBeaconSafely call) — so `fired` lands first in the
    // sink and only `beaconRank` (submission-reader.ts), not write order,
    // makes it win the fold.
    expect(beaconLines[0]?.beaconStatus).toBe("fired");
    expect(beaconLines[1]?.beaconStatus).toBe("skipped");

    const rows = await readReconciliationRows({ sinkPath });
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.siteId).toBe("e2e-self-recording");
    expect(row?.status).toBe("submitted");
    expect(row?.joinKeys).toEqual(joinKeys);
    expect(row?.beaconStatus).toBe("fired");
    expect(row?.beaconTrackingUrl).toBe(trackingUrl);
  });

  it("folds a plugin's richer self-recorded fired beacon over the engine's skipped beacon, keeping the submit line's narrow joinKeys and nulling the trackingUrl, dispatched over real HTTP", async () => {
    const trackingUrl =
      "https://click.e2e-test.example/t/divergent?vivclid=e2e-789&empId=emp3&jid=jid3";
    const narrowJoinKeys = { vivclid: "e2e-789" };
    const supersetJoinKeys = { vivclid: "e2e-789", jobReference: "emp3_jid3" };

    const divergentPlugin: SitePlugin<unknown, unknown> = {
      extractJoinKeys: (payload) => {
        const { TrackingUrl } = payload as { TrackingUrl?: string };
        return TrackingUrl ? narrowJoinKeys : null;
      },
      meta: {
        siteId: "e2e-divergent",
        displayName: "E2E Divergent",
        bodySchema: z.object({ TrackingUrl: z.string().optional() }),
        responseSchema: z.object({ verified: z.boolean() }),
      },
      execute: vi.fn(),
      executeHttp: async (_payload, context): Promise<SitePluginResult<unknown>> => {
        await context.recordBeaconOutcome({
          beaconStatus: "fired",
          joinKeys: supersetJoinKeys,
        });
        return { data: { verified: true } };
      },
    };

    const app = Fastify({ loggerInstance: getLogger({ name: "dispatch-telemetry-e2e-test" }) });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(errorHandlerPlugin);
    await app.register(authPlugin);
    await registerRoutes(app, cfgStub, [divergentPlugin]);
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/v1/e2e-divergent/run",
      payload: { TrackingUrl: trackingUrl },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().verified).toBe(true);

    await app.close();

    const rawLines = fs
      .readFileSync(sinkPath, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map(
        (line) =>
          JSON.parse(line) as {
            kind: string;
            beaconStatus?: string;
            joinKeys?: unknown;
            trackingUrl?: string | null;
          }
      );
    const beaconLines = rawLines.filter((line) => line.kind === "beacon");
    expect(beaconLines).toHaveLength(2);
    expect(beaconLines[0]?.beaconStatus).toBe("fired");
    expect(beaconLines[0]?.joinKeys).toEqual(supersetJoinKeys);
    expect(beaconLines[0]?.trackingUrl).toBeNull();
    expect(beaconLines[1]?.beaconStatus).toBe("skipped");
    expect(beaconLines[1]?.joinKeys).toEqual(narrowJoinKeys);
    expect(beaconLines[1]?.trackingUrl).toBe(trackingUrl);

    const rows = await readReconciliationRows({ sinkPath });
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.siteId).toBe("e2e-divergent");
    expect(row?.status).toBe("submitted");
    expect(row?.beaconStatus).toBe("fired");
    expect(row?.joinKeys).toEqual(narrowJoinKeys);
    expect(row?.beaconTrackingUrl).toBeNull();
  });
});
