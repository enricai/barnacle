import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildConfigPlugin } from "@/plugins/config-plugin";
import { emitConfigPluginManifest } from "@/scripts/recon-generate";

const mockRunHealingFlow = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ submitVerified: true, submitStepSkipped: false, lastStepIndex: 1 })
);
const mockGuardedExtract = vi.hoisted(() => vi.fn().mockResolvedValue({ confirmationId: "X" }));

vi.mock("@/scraper/flow-runner", () => ({ runHealingFlow: mockRunHealingFlow }));
vi.mock("@/scraper/stagehand-guard", () => ({ guardedExtract: mockGuardedExtract }));
vi.mock("@/lib/bedrock", () => ({ createBedrockModel: vi.fn(() => ({})) }));

function deps(): { session: never; context: never } {
  const page = { goto: async (): Promise<void> => undefined, url: (): string => "about:blank" };
  return {
    session: { stagehand: { context: { awaitActivePage: async () => page } } } as never,
    context: {
      baseUrl: "https://apply.acme.example",
      config: {
        scraper: { useBedrock: false, anthropicApiKey: undefined, model: "m" },
        bedrock: { region: "r", model: "m" },
      },
      metricsCollector: { startStep: () => undefined, endStep: () => undefined },
      logger: { info: () => undefined, warn: () => undefined },
      requestId: "t",
    } as never,
  };
}

function manifest(steps: unknown[], submissionFlow?: boolean): Record<string, unknown> {
  return {
    apiVersion: "barnacle.dev/v1",
    kind: "SitePlugin",
    metadata: { siteId: "acme-jobs" },
    spec: {
      request: { type: "object", properties: {} },
      response: { type: "object", properties: {} },
      flow: { steps, ...(submissionFlow === undefined ? {} : { submissionFlow }) },
      extract: { instruction: "x", schema: { type: "object", properties: {} } },
    },
  };
}

describe("submission flow without a submitStep", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refuses success", async () => {
    const plugin = await buildConfigPlugin(manifest(["click apply", "click next"], true));
    const { session, context } = deps();
    await expect(plugin.execute({}, session, context)).rejects.toThrow(/no submitStep/);
    expect(mockGuardedExtract).not.toHaveBeenCalled();
  });

  it("still succeeds with a verified submitStep", async () => {
    const plugin = await buildConfigPlugin(
      manifest(["click apply", { step: "submit", submitStep: true }], true)
    );
    const { session, context } = deps();
    const r = await plugin.execute({}, session, context);
    expect(r).toEqual({ data: { confirmationId: "X" } });
  });

  it("read flow without marker still succeeds", async () => {
    const plugin = await buildConfigPlugin(manifest(["click apply"]));
    const { session, context } = deps();
    await expect(plugin.execute({}, session, context)).resolves.toBeDefined();
  });

  it("emitter marks submission flows", () => {
    const json = JSON.parse(
      emitConfigPluginManifest({
        siteId: "acme-jobs",
        baseUrl: "https://a.example",
        flowSteps: ["click apply", "click next"],
        isSubmissionFlow: true,
      })
    );
    expect(json.spec.flow.submissionFlow).toBe(true);
  });
});
