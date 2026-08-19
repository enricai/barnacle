/**
 * Regression tests for buildAnthropicClient's useBedrock/anthropicApiKey
 * gating: a Bedrock-only deployment or a missing key must degrade to `null`
 * instead of the self-heal cascade crashing on an unconfigured client.
 */

import Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { configStub } = vi.hoisted(() => ({
  configStub: {
    scraper: {
      useBedrock: false,
      anthropicApiKey: undefined as string | undefined,
      model: "anthropic/claude-sonnet-4-6",
    },
    bedrock: {
      region: "us-east-1",
      accessKeyId: undefined,
      secretAccessKey: undefined,
      sessionToken: undefined,
      model: "us.anthropic.claude-sonnet-4-6",
    },
  },
}));

vi.mock("@/config", () => ({ config: configStub }));

const { createBedrockModelStub } = vi.hoisted(() => ({
  createBedrockModelStub: vi.fn(() => ({ specificationVersion: "v2", modelId: "bedrock-model" })),
}));

vi.mock("@/lib/bedrock", () => ({ createBedrockModel: createBedrockModelStub }));

describe("buildAnthropicClient", () => {
  beforeEach(() => {
    configStub.scraper.useBedrock = false;
    configStub.scraper.anthropicApiKey = undefined;
  });

  it("returns null on a Bedrock-only deployment", async () => {
    configStub.scraper.useBedrock = true;
    configStub.scraper.anthropicApiKey = "test-key";
    const { buildAnthropicClient } = await import("@/lib/llm/anthropic-client.js");
    expect(buildAnthropicClient()).toBeNull();
  });

  it("returns null when no Anthropic API key is configured", async () => {
    configStub.scraper.useBedrock = false;
    configStub.scraper.anthropicApiKey = undefined;
    const { buildAnthropicClient } = await import("@/lib/llm/anthropic-client.js");
    expect(buildAnthropicClient()).toBeNull();
  });

  it("returns an Anthropic client when a key is configured", async () => {
    configStub.scraper.useBedrock = false;
    configStub.scraper.anthropicApiKey = "test-key";
    const { buildAnthropicClient } = await import("@/lib/llm/anthropic-client.js");
    const client = buildAnthropicClient();
    expect(client).toBeInstanceOf(Anthropic);
  });
});

/**
 * Assertions target runtime object shape (typeof, key presence) rather than
 * a specific exported type name, so they hold regardless of whether
 * RephraseModel stays derived from `ai`'s LanguageModel union or is
 * reworked to widen bedrock.ts's StagehandModel.
 */
describe("buildRephraseModel", () => {
  beforeEach(() => {
    configStub.scraper.useBedrock = false;
    configStub.scraper.anthropicApiKey = undefined;
    createBedrockModelStub.mockClear();
  });

  it("delegates to createBedrockModel on a Bedrock-only deployment", async () => {
    configStub.scraper.useBedrock = true;
    const { buildRephraseModel } = await import("@/lib/llm/anthropic-client.js");
    const model = buildRephraseModel();
    expect(createBedrockModelStub).toHaveBeenCalledWith(configStub.bedrock);
    expect(model).toEqual({ specificationVersion: "v2", modelId: "bedrock-model" });
  });

  it("returns null when neither Bedrock nor an Anthropic key is configured", async () => {
    configStub.scraper.useBedrock = false;
    configStub.scraper.anthropicApiKey = undefined;
    const { buildRephraseModel } = await import("@/lib/llm/anthropic-client.js");
    expect(buildRephraseModel()).toBeNull();
  });

  it("strips the anthropic/ prefix and resolves a live AI-SDK language model", async () => {
    configStub.scraper.useBedrock = false;
    configStub.scraper.anthropicApiKey = "test-key";
    configStub.scraper.model = "anthropic/claude-sonnet-4-6";
    const { buildRephraseModel } = await import("@/lib/llm/anthropic-client.js");
    const model = buildRephraseModel();
    expect(model).not.toBeNull();
    expect(typeof model).toBe("object");
    expect((model as { modelId?: unknown }).modelId).toBe("claude-sonnet-4-6");
    expect(typeof (model as { doGenerate?: unknown }).doGenerate).toBe("function");
  });
});
