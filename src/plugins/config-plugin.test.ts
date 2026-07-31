import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildConfigPlugin, CONFIG_PLUGIN_MANIFEST } from "@/plugins/config-plugin";

const mockRunHealingFlow = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ submitVerified: false, submitStepSkipped: false, lastStepIndex: -1 })
);
const mockGuardedExtract = vi.hoisted(() => vi.fn().mockResolvedValue({ confirmationId: "X" }));

vi.mock("@/scraper/flow-runner", () => ({ runHealingFlow: mockRunHealingFlow }));
vi.mock("@/scraper/stagehand-guard", () => ({ guardedExtract: mockGuardedExtract }));

const FIXTURES_DIR = path.join(__dirname, "__fixtures__");

/** Minimal mocked browser session + context so `execute` runs without a real Stagehand. */
function mockExecuteDeps(): { session: never; context: never } {
  const page = { goto: async (): Promise<void> => undefined, url: (): string => "about:blank" };
  const session = {
    stagehand: { context: { awaitActivePage: async () => page } },
  } as never;
  const context = {
    baseUrl: "https://apply.acme.example",
    config: { scraper: { anthropicApiKey: undefined } },
    metricsCollector: { startStep: () => undefined, endStep: () => undefined },
    logger: { info: () => undefined, warn: () => undefined },
    requestId: "test",
  } as never;
  return { session, context };
}

/** A minimal, valid browser-only manifest used as the base for each test. */
function baseManifest(): Record<string, unknown> {
  return {
    apiVersion: "barnacle.dev/v1",
    kind: "SitePlugin",
    metadata: { siteId: "acme-jobs", displayName: "Acme Jobs" },
    spec: {
      defaultBaseUrl: "https://apply.acme.example",
      request: {
        type: "object",
        required: ["FirstName", "Email"],
        properties: { FirstName: { type: "string" }, Email: { type: "string" } },
      },
      response: { type: "object", properties: { confirmationId: { type: "string" } } },
      flow: {
        steps: ["click apply", { step: "fill First Name with {{ .request.FirstName }}" }],
        successUrlFragments: ["confirmation"],
      },
      extract: {
        instruction: "extract the confirmation id",
        schema: { type: "object", properties: { confirmationId: { type: "string" } } },
      },
    },
  };
}

describe("buildConfigPlugin", () => {
  beforeEach(() => {
    mockRunHealingFlow.mockClear();
    mockGuardedExtract.mockClear();
  });

  it("synthesizes a SitePlugin with real Zod schemas and mapped meta", async () => {
    const plugin = await buildConfigPlugin(baseManifest());

    expect(plugin.meta.siteId).toBe("acme-jobs");
    expect(plugin.meta.displayName).toBe("Acme Jobs");
    expect(plugin.meta.defaultBaseUrl).toBe("https://apply.acme.example");
    // bodySchema/responseSchema must duck-type as Zod for the loader's gate.
    expect(typeof plugin.meta.bodySchema.safeParse).toBe("function");
    expect(typeof plugin.meta.responseSchema.parse).toBe("function");
    expect(plugin.meta.bodySchema.safeParse({ FirstName: "J", Email: "e" }).success).toBe(true);
    expect(plugin.meta.bodySchema.safeParse({ FirstName: "J" }).success).toBe(false);
    expect(typeof plugin.execute).toBe("function");
  });

  it("is browser-only (no executeHttp) when the manifest omits httpModule", async () => {
    const plugin = await buildConfigPlugin(baseManifest());
    expect(plugin.executeHttp).toBeUndefined();
  });

  it("attaches executeHttp from a relative httpModule resolved against baseDir", async () => {
    const manifest = baseManifest();
    (manifest.spec as Record<string, unknown>).httpModule = "./config-http-module.js";

    const plugin = await buildConfigPlugin(manifest, FIXTURES_DIR);

    const { executeHttp } = plugin;
    if (executeHttp === undefined) throw new Error("expected executeHttp to be attached");
    const result = await executeHttp({ FirstName: "J", Email: "e" }, {} as never);
    expect((result.data as { confirmationId?: string }).confirmationId).toBe("HTTP-CONF-1");
  });

  it("rejects a manifest whose httpModule cannot be resolved", async () => {
    const manifest = baseManifest();
    (manifest.spec as Record<string, unknown>).httpModule = "./does-not-exist.js";
    await expect(buildConfigPlugin(manifest, FIXTURES_DIR)).rejects.toThrow();
  });

  it("rejects a manifest with the wrong apiVersion", async () => {
    const bad = { ...baseManifest(), apiVersion: "wrong/v1" };
    await expect(buildConfigPlugin(bad)).rejects.toThrow();
  });

  it("rejects a manifest whose request schema uses an unsupported type", async () => {
    const bad = baseManifest();
    (bad.spec as Record<string, unknown>).request = {
      type: "object",
      properties: { X: { type: "nope" } },
    };
    await expect(buildConfigPlugin(bad)).rejects.toThrow();
  });

  it("throws inside execute when a flow step references an UNDECLARED request field", async () => {
    const manifest = baseManifest();
    (manifest.spec as { flow: { steps: unknown[] } }).flow.steps = [
      { step: "fill with {{ .request.DoesNotExist }}" },
    ];
    const plugin = await buildConfigPlugin(manifest);
    const { session, context } = mockExecuteDeps();

    await expect(plugin.execute({ FirstName: "J", Email: "e" }, session, context)).rejects.toThrow(
      /unknown request field "DoesNotExist"/
    );
  });

  it("does NOT throw when an OPTIONAL declared field is omitted (splices empty string)", async () => {
    // Phone is declared but not required, and referenced by an optional step —
    // omitting it must resolve to "" rather than throwing "unknown request field".
    const manifest = baseManifest();
    (
      manifest.spec as { request: { properties: Record<string, unknown> } }
    ).request.properties.Phone = { type: "string" };
    (manifest.spec as { flow: { steps: unknown[] } }).flow.steps = [
      { step: "fill the Phone field with {{ .request.Phone }}", optional: true },
    ];
    const plugin = await buildConfigPlugin(manifest);
    const { session, context } = mockExecuteDeps();

    await expect(
      plugin.execute({ FirstName: "J", Email: "e" }, session, context)
    ).resolves.toBeDefined();

    const steps = mockRunHealingFlow.mock.calls[0]?.[0]?.steps as { instruction: string }[];
    expect(steps[0]?.instruction).toBe("fill the Phone field with ");
  });

  it("surfaces a failure when the flow's submitStep was skipped rather than verified", async () => {
    mockRunHealingFlow.mockResolvedValueOnce({
      submitVerified: false,
      submitStepSkipped: true,
      lastStepIndex: 1,
    });
    const manifest = baseManifest();
    (manifest.spec as { flow: { steps: unknown[] } }).flow.steps = [
      "click apply",
      { step: "submit the application", submitStep: true },
    ];
    const plugin = await buildConfigPlugin(manifest);
    const { session, context } = mockExecuteDeps();

    await expect(plugin.execute({ FirstName: "J", Email: "e" }, session, context)).rejects.toThrow(
      /submitStep was not verified/
    );
    expect(mockGuardedExtract).not.toHaveBeenCalled();
  });

  it("returns data when the flow's submitStep verifies", async () => {
    mockRunHealingFlow.mockResolvedValueOnce({
      submitVerified: true,
      submitStepSkipped: false,
      lastStepIndex: 1,
    });
    const manifest = baseManifest();
    (manifest.spec as { flow: { steps: unknown[] } }).flow.steps = [
      "click apply",
      { step: "submit the application", submitStep: true },
    ];
    const plugin = await buildConfigPlugin(manifest);
    const { session, context } = mockExecuteDeps();

    const result = await plugin.execute({ FirstName: "J", Email: "e" }, session, context);
    expect((result.data as { confirmationId?: string }).confirmationId).toBe("X");
  });

  it("does not require submit verification when the flow has no submitStep", async () => {
    const plugin = await buildConfigPlugin(baseManifest());
    const { session, context } = mockExecuteDeps();

    await expect(
      plugin.execute({ FirstName: "J", Email: "e" }, session, context)
    ).resolves.toBeDefined();
  });
});

describe("CONFIG_PLUGIN_MANIFEST", () => {
  it("requires kind to be SitePlugin", () => {
    const bad = { ...baseManifest(), kind: "Widget" };
    expect(CONFIG_PLUGIN_MANIFEST.safeParse(bad).success).toBe(false);
  });

  it("requires a non-empty flow", () => {
    const bad = baseManifest();
    (bad.spec as { flow: { steps: unknown[] } }).flow.steps = [];
    expect(CONFIG_PLUGIN_MANIFEST.safeParse(bad).success).toBe(false);
  });
});
