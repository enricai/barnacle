/**
 * End-to-end guard that request values never leave the process through
 * telemetry or the error reply: a real Fastify app (app.inject), a real
 * dispatch(), and the real calls/submissions NDJSON writers on disk. The test
 * plugin behaves like a failing browser flow — it embeds the request's
 * values and a generated password in an instruction, captures it as an LLM
 * call, then fails with that instruction in the error message.
 */

import * as fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { Writable } from "node:stream";

import Fastify, { type FastifyInstance, type RawServerDefault } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

import authPlugin from "@/api/plugins/auth";
import errorHandlerPlugin from "@/api/plugins/error-handler";
import type { AppConfig } from "@/config";
import { extendLogger, getLogger, PII_REDACTING_LOG_HOOKS } from "@/lib/logging";
import { resetSensitiveValuesForTests } from "@/lib/pii-redaction";
import { generateThrowawayPassword } from "@/lib/random";
import { captureLlmCall } from "@/lib/telemetry/call-capture";
import { buildPluginContext, dispatch, registerRoutes } from "@/plugins/loader";
import { StepVerificationError } from "@/scraper/errors";
import type { SitePlugin, SitePluginResult } from "@/site-plugin";
import type { Logger } from "@/types/logging";
import type { RedactionPolicy } from "@/types/pii-redaction";

const sinkPaths = vi.hoisted(() => ({
  submissions: "/tmp/pii-redaction-e2e-unset-submissions.ndjson",
  calls: "/tmp/pii-redaction-e2e-unset-calls.ndjson",
}));

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
        telemetry: {
          ...actual.config.telemetry,
          submissionsNdjsonPath: sinkPaths.submissions,
          callsNdjsonPath: sinkPaths.calls,
        },
      };
    },
  };
});

const cfgStub = { scraper: { siteBaseUrls: {} } } as unknown as AppConfig;

const REQUEST = {
  JobId: "JOB-424242",
  FirstName: "Sentinelfirst",
  LastName: "Sentinellast",
  Email: "sentinel.requester@example.com",
  Phone: "+15559876543",
};

const REQUEST_SCHEMA = z.object({
  JobId: z.string(),
  FirstName: z.string(),
  LastName: z.string(),
  Email: z.string(),
  Phone: z.string(),
});

const REDACTION: RedactionPolicy = {
  persistKeys: ["JobId"],
  wordKeys: ["FirstName", "LastName", "Email"],
  digitKeys: ["Phone"],
};

const SENTINELS = [
  /Sentinelfirst/i,
  /Sentinellast/i,
  /sentinel\.requester@example\.com/i,
  /5559876543/,
];

describe("dispatch() keeps request values out of telemetry and error replies", () => {
  let tmpDir: string;
  const preservedEnv = {
    DEV_BYPASS_AUTH: process.env.DEV_BYPASS_AUTH,
    NODE_ENV: process.env.NODE_ENV,
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pii-redaction-e2e-"));
    sinkPaths.submissions = path.join(tmpDir, "submissions.ndjson");
    sinkPaths.calls = path.join(tmpDir, "calls.ndjson");
    process.env.DEV_BYPASS_AUTH = "true";
    process.env.NODE_ENV = "development";
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (preservedEnv.DEV_BYPASS_AUTH === undefined) delete process.env.DEV_BYPASS_AUTH;
    else process.env.DEV_BYPASS_AUTH = preservedEnv.DEV_BYPASS_AUTH;
    if (preservedEnv.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = preservedEnv.NODE_ENV;
    resetSensitiveValuesForTests();
    vi.clearAllMocks();
  });

  async function buildApp(
    plugin: SitePlugin<unknown, unknown>,
    loggerInstance: Logger = getLogger({ name: "pii-redaction-e2e-test" })
  ): Promise<FastifyInstance<RawServerDefault, IncomingMessage, ServerResponse, Logger>> {
    const app = Fastify({ loggerInstance });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(errorHandlerPlugin);
    await app.register(authPlugin);
    await registerRoutes(app, cfgStub, [plugin]);
    await app.ready();
    return app;
  }

  it("redacts payload values and the generated password from calls, submissions and the 500 body", async () => {
    const generated = { password: "" };
    const plugin: SitePlugin<unknown, unknown> = {
      meta: {
        siteId: "pii-e2e",
        displayName: "PII E2E",
        bodySchema: REQUEST_SCHEMA,
        responseSchema: z.object({ verified: z.boolean() }),
        redaction: REDACTION,
      },
      execute: vi.fn(),
      executeHttp: async (payload): Promise<SitePluginResult<unknown>> => {
        const p = payload as typeof REQUEST;
        generated.password = generateThrowawayPassword();
        const instruction = `Fill in Email with '${p.Email}', Phone with '${p.Phone}', name '${p.FirstName.toUpperCase()} ${p.LastName}', Password with '${generated.password}'`;
        await captureLlmCall({
          callId: "call-1",
          callType: "stagehand_act",
          userContent: instruction,
          responseContent: JSON.stringify([
            { method: "fill", arguments: [p.Email, generated.password] },
          ]),
          latencyMs: 1,
          success: false,
          parsedOk: false,
          errorMessage: instruction,
          failureKind: null,
          model: "stagehand-internal",
          systemPrompt: null,
          inputTokens: null,
          outputTokens: null,
        });
        throw new StepVerificationError(`step 2/9 (${instruction.slice(0, 60)}) failed`);
      },
    };

    const app = await buildApp(plugin);
    const response = await app.inject({
      method: "POST",
      url: "/v1/pii-e2e/run",
      payload: REQUEST,
    });
    await app.close();

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    const outputs = {
      reply: response.body,
      calls: fs.readFileSync(sinkPaths.calls, "utf-8"),
      submissions: fs.readFileSync(sinkPaths.submissions, "utf-8"),
    };
    expect(generated.password.length).toBeGreaterThan(20);
    for (const [sink, text] of Object.entries(outputs)) {
      for (const sentinel of [...SENTINELS, new RegExp(generated.password)]) {
        expect({ sink, leaked: sentinel.test(text) }).toEqual({ sink, leaked: false });
      }
    }
    expect(outputs.calls).toContain("<Email>");
    expect(outputs.calls).toContain("<Secret>");
    expect(outputs.submissions).toContain("JOB-424242");
  });

  it("redacts an extra route's body values from its logs and error reply", async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb): void {
        lines.push(String(chunk));
        cb();
      },
    });
    const plugin: SitePlugin<unknown, unknown> = {
      meta: {
        siteId: "pii-e2e",
        displayName: "PII E2E",
        bodySchema: REQUEST_SCHEMA,
        responseSchema: z.object({ verified: z.boolean() }),
        redaction: REDACTION,
        extraRoutes: [
          {
            method: "post",
            path: "/v1/pii-e2e/follow-up",
            bodySchema: REQUEST_SCHEMA,
            handler: async (request): Promise<unknown> => {
              const body = request.body as typeof REQUEST;
              request.log.info(`follow-up for ${body.Email} (${body.FirstName} ${body.LastName})`);
              throw new StepVerificationError(`follow-up rejected ${body.Email} ${body.Phone}`);
            },
          },
        ],
      },
      execute: vi.fn(),
    };

    const app = await buildApp(
      plugin,
      extendLogger(pino({ hooks: PII_REDACTING_LOG_HOOKS }, sink))
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/pii-e2e/follow-up",
      payload: REQUEST,
    });
    await app.close();

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    const outputs = { reply: response.body, logs: lines.join("") };
    for (const [sink, text] of Object.entries(outputs)) {
      for (const sentinel of SENTINELS) {
        expect({ sink, leaked: sentinel.test(text) }).toEqual({ sink, leaked: false });
      }
    }
    expect(outputs.logs).toContain("<Email>");
  });

  it("persists the plugin's declared keys when dispatch() is called without registerRoutes", async () => {
    const plugin: SitePlugin<unknown, unknown> = {
      meta: {
        siteId: "pii-e2e-direct",
        displayName: "PII E2E direct",
        bodySchema: REQUEST_SCHEMA,
        responseSchema: z.object({ verified: z.boolean() }),
        redaction: REDACTION,
      },
      execute: vi.fn(),
      executeHttp: async (): Promise<SitePluginResult<unknown>> => ({ data: { verified: true } }),
    };
    const context = buildPluginContext({
      plugin,
      cfg: cfgStub,
      requestId: "req-direct",
      logger: getLogger({ name: "pii-redaction-e2e-direct" }),
    });

    await dispatch(plugin, REQUEST, context);

    const row = fs
      .readFileSync(sinkPaths.submissions, "utf-8")
      .trim()
      .split("\n")
      .map(
        (line) => JSON.parse(line) as { kind?: string; inboundPayload?: Record<string, unknown> }
      )
      .find((r) => r.kind === "submit");
    expect(row?.inboundPayload?.JobId).toBe(REQUEST.JobId);
    expect(JSON.stringify(row)).not.toMatch(SENTINELS[2] as RegExp);
  });
});
