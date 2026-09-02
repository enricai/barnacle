import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildConfigPlugin, CONFIG_PLUGIN_MANIFEST } from "@/plugins/config-plugin";

const mockRunHealingFlow = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ submitVerified: false, submitStepSkipped: false, lastStepIndex: -1 })
);
const mockGuardedExtract = vi.hoisted(() => vi.fn().mockResolvedValue({ confirmationId: "X" }));
const mockCreateBedrockModel = vi.hoisted(() =>
  vi.fn(() => ({ specificationVersion: "v2", modelId: "bedrock-model" }))
);

vi.mock("@/scraper/flow-runner", () => ({ runHealingFlow: mockRunHealingFlow }));
vi.mock("@/scraper/stagehand-guard", () => ({ guardedExtract: mockGuardedExtract }));
vi.mock("@/lib/bedrock", () => ({ createBedrockModel: mockCreateBedrockModel }));

const FIXTURES_DIR = path.join(__dirname, "__fixtures__");

/** Minimal mocked browser session + context so `execute` runs without a real Stagehand. */
function mockExecuteDeps(scraperOverrides: Record<string, unknown> = {}): {
  session: never;
  context: never;
} {
  const page = { goto: async (): Promise<void> => undefined, url: (): string => "about:blank" };
  const session = {
    stagehand: { context: { awaitActivePage: async () => page } },
  } as never;
  const context = {
    baseUrl: "https://apply.acme.example",
    config: {
      scraper: {
        useBedrock: false,
        anthropicApiKey: undefined,
        model: "anthropic/claude-sonnet-4-6",
        ...scraperOverrides,
      },
      bedrock: {
        region: "us-east-1",
        accessKeyId: undefined,
        secretAccessKey: undefined,
        sessionToken: undefined,
        model: "us.anthropic.claude-sonnet-4-6",
      },
    },
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
    mockCreateBedrockModel.mockClear();
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

  it("parses and loads a manifest that omits metadata.displayName, leaving meta.displayName undefined", async () => {
    const manifest = baseManifest();
    (manifest.metadata as Record<string, unknown>) = { siteId: "acme-jobs" };

    expect(() => CONFIG_PLUGIN_MANIFEST.parse(manifest)).not.toThrow();

    const plugin = await buildConfigPlugin(manifest);

    expect(plugin.meta.siteId).toBe("acme-jobs");
    expect(plugin.meta.displayName).toBeUndefined();
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

  it("threads captchaGated through to the HealingFlowStep passed to runHealingFlow, mirroring submitStep", async () => {
    mockRunHealingFlow.mockResolvedValueOnce({
      submitVerified: true,
      submitStepSkipped: false,
      lastStepIndex: 1,
    });
    const manifest = baseManifest();
    (manifest.spec as { flow: { steps: unknown[] } }).flow.steps = [
      "click apply",
      { step: "submit the application", submitStep: true, captchaGated: true },
    ];
    const plugin = await buildConfigPlugin(manifest);
    const { session, context } = mockExecuteDeps();

    await plugin.execute({ FirstName: "J", Email: "e" }, session, context);

    const steps = mockRunHealingFlow.mock.calls[0]?.[0]?.steps as {
      submitStep: boolean;
      captchaGated: boolean;
    }[];
    expect(steps[0]?.captchaGated).toBe(false);
    expect(steps[1]?.submitStep).toBe(true);
    expect(steps[1]?.captchaGated).toBe(true);
  });

  it("forwards a templated navigateTo through to the HealingFlowStep passed to runHealingFlow", async () => {
    const manifest = baseManifest();
    (manifest.spec as { flow: { steps: unknown[] } }).flow.steps = [
      "click apply",
      { step: "go to the dashboard", navigateTo: "https://apply.acme.example/{{ .request.FirstName }}" },
    ];
    const plugin = await buildConfigPlugin(manifest);
    const { session, context } = mockExecuteDeps();

    await plugin.execute({ FirstName: "J", Email: "e" }, session, context);

    const steps = mockRunHealingFlow.mock.calls[0]?.[0]?.steps as { navigateTo?: string }[];
    expect(steps[0]?.navigateTo).toBeUndefined();
    expect(steps[1]?.navigateTo).toBe("https://apply.acme.example/J");
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

  it("forwards spec.flow.frameSelector into the runHealingFlow deps when set", async () => {
    const manifest = baseManifest();
    (manifest.spec as { flow: { frameSelector?: string } }).flow.frameSelector = "#apply_frame";
    const plugin = await buildConfigPlugin(manifest);
    const { session, context } = mockExecuteDeps();

    await plugin.execute({ FirstName: "J", Email: "e" }, session, context);

    const deps = mockRunHealingFlow.mock.calls[0]?.[0] as { frameSelector?: string };
    expect(deps.frameSelector).toBe("#apply_frame");
  });

  it("forwards undefined frameSelector when the manifest omits it (today's behavior)", async () => {
    const plugin = await buildConfigPlugin(baseManifest());
    const { session, context } = mockExecuteDeps();

    await plugin.execute({ FirstName: "J", Email: "e" }, session, context);

    const deps = mockRunHealingFlow.mock.calls[0]?.[0] as { frameSelector?: string };
    expect(deps.frameSelector).toBeUndefined();
  });

  it("round-trips a manifest-declared frameSelector through CONFIG_PLUGIN_MANIFEST parsing", async () => {
    const manifest = baseManifest();
    (manifest.spec as { flow: { frameSelector?: string } }).flow.frameSelector = "#apply_frame";

    const parsed = CONFIG_PLUGIN_MANIFEST.parse(manifest);
    expect(parsed.spec.flow.frameSelector).toBe("#apply_frame");

    const plugin = await buildConfigPlugin(manifest);
    const { session, context } = mockExecuteDeps();
    await plugin.execute({ FirstName: "J", Email: "e" }, session, context);

    const deps = mockRunHealingFlow.mock.calls[0]?.[0] as { frameSelector?: string };
    expect(deps.frameSelector).toBe("#apply_frame");
  });

  it("rejects a manifest with an empty-string frameSelector", async () => {
    const manifest = baseManifest();
    (manifest.spec as { flow: { frameSelector?: string } }).flow.frameSelector = "";

    expect(CONFIG_PLUGIN_MANIFEST.safeParse(manifest).success).toBe(false);
    await expect(buildConfigPlugin(manifest)).rejects.toThrow(/frameSelector/);
  });

  it("rejects a manifest with a non-string frameSelector", async () => {
    const manifest = baseManifest();
    (manifest.spec as { flow: { frameSelector?: unknown } }).flow.frameSelector = 123;

    expect(CONFIG_PLUGIN_MANIFEST.safeParse(manifest).success).toBe(false);
    await expect(buildConfigPlugin(manifest)).rejects.toThrow(/frameSelector/);
  });

  it("runs an emailStep manifest through runHealingFlow with an allocatedInbox derived from payload.Email", async () => {
    const manifest = baseManifest();
    (manifest.spec as { flow: { steps: unknown[] } }).flow.steps[1] = {
      step: "fill verification code with ''",
      emailStep: true,
      emailStepConfig: { extract: "code", action: "fill" },
    };
    const plugin = await buildConfigPlugin(manifest);
    const { session, context } = mockExecuteDeps();

    const result = await plugin.execute(
      { FirstName: "J", Email: "ns.tag@inbox.testmail.app" },
      session,
      context
    );

    expect((result.data as { confirmationId?: string }).confirmationId).toBe("X");
    const deps = mockRunHealingFlow.mock.calls[0]?.[0] as {
      allocatedInbox?: { address?: string };
      steps: { emailStep?: boolean; emailStepConfig?: { extract?: string; action?: string } }[];
    };
    expect(deps.allocatedInbox?.address).toBe("ns.tag@inbox.testmail.app");
    expect(deps.steps[1]?.emailStep).toBe(true);
    expect(deps.steps[1]?.emailStepConfig).toEqual({ extract: "code", action: "fill" });
  });

  it("rejects a manifest declaring emailStep with no Email field in request.properties", async () => {
    const manifest = baseManifest();
    (manifest.spec as { flow: { steps: unknown[] } }).flow.steps[1] = {
      step: "fill verification code with ''",
      emailStep: true,
    };
    (
      manifest.spec as {
        request: { type: string; required: string[]; properties: Record<string, unknown> };
      }
    ).request = {
      type: "object",
      required: ["FirstName"],
      properties: { FirstName: { type: "string" } },
    };

    await expect(buildConfigPlugin(manifest)).rejects.toThrow(
      /emailStep requires an "Email" field/
    );
  });
});

describe("buildRephraseModelForContext (via execute)", () => {
  beforeEach(() => {
    mockRunHealingFlow.mockClear();
    mockCreateBedrockModel.mockClear();
  });

  it("delegates to createBedrockModel on a Bedrock-only per-request config", async () => {
    const plugin = await buildConfigPlugin(baseManifest());
    const { session, context } = mockExecuteDeps({ useBedrock: true });

    await plugin.execute({ FirstName: "J", Email: "e" }, session, context);

    expect(mockCreateBedrockModel).toHaveBeenCalledWith(
      (context as { config: { bedrock: unknown } }).config.bedrock
    );
    const deps = mockRunHealingFlow.mock.calls[0]?.[0] as { rephraseModel: unknown };
    expect(deps.rephraseModel).toEqual({ specificationVersion: "v2", modelId: "bedrock-model" });
  });

  it("passes a null rephraseModel when neither Bedrock nor an Anthropic key is configured", async () => {
    const plugin = await buildConfigPlugin(baseManifest());
    const { session, context } = mockExecuteDeps({ useBedrock: false, anthropicApiKey: undefined });

    await plugin.execute({ FirstName: "J", Email: "e" }, session, context);

    expect(mockCreateBedrockModel).not.toHaveBeenCalled();
    const deps = mockRunHealingFlow.mock.calls[0]?.[0] as { rephraseModel: unknown };
    expect(deps.rephraseModel).toBeNull();
  });

  it("resolves a live AI-SDK language model when an anthropicApiKey is configured", async () => {
    const plugin = await buildConfigPlugin(baseManifest());
    const { session, context } = mockExecuteDeps({
      useBedrock: false,
      anthropicApiKey: "test-key",
      model: "anthropic/claude-sonnet-4-6",
    });

    await plugin.execute({ FirstName: "J", Email: "e" }, session, context);

    const deps = mockRunHealingFlow.mock.calls[0]?.[0] as { rephraseModel: { modelId?: unknown } };
    expect(deps.rephraseModel).not.toBeNull();
    expect(deps.rephraseModel?.modelId).toBe("claude-sonnet-4-6");
    expect(typeof (deps.rephraseModel as { doGenerate?: unknown }).doGenerate).toBe("function");
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
