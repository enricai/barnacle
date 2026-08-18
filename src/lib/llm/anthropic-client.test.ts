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
    },
  },
}));

vi.mock("@/config", () => ({ config: configStub }));

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
