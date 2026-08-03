import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { createBedrockModel } from "@/lib/bedrock";

describe("createBedrockModel", () => {
  it("produces a model with the specificationVersion Stagehand's AISdkClient requires", () => {
    const model = createBedrockModel({
      region: "us-east-1",
      accessKeyId: undefined,
      secretAccessKey: undefined,
      sessionToken: undefined,
      model: "us.anthropic.claude-sonnet-4-6",
    });

    expect(model.specificationVersion).toBe("v2");
  });
});

/**
 * Stagehand's AISdkClient infers the AI SDK provider name by splitting
 * modelId on "/", which never matches Bedrock-native IDs (e.g.
 * "us.anthropic.claude-opus-5" has no "/"). Without the patch in
 * patches/@browserbasehq__stagehand.patch, Bedrock-routed Claude models
 * silently never get providerOptions.anthropic.structuredOutputMode set,
 * degrading act()/extract() reliability. This reads the patched dist file
 * directly (not a reimplementation) so a `pnpm install` that drops the
 * patch fails this test instead of passing silently.
 */
describe("Stagehand aisdk.js inferProviderName patch (Bedrock support)", () => {
  const stagehandPackageRoot = dirname(require.resolve("@browserbasehq/stagehand/package.json"));
  const stagehandAisdkPath = join(stagehandPackageRoot, "dist/cjs/lib/v3/llm/aisdk.js");
  const source = readFileSync(stagehandAisdkPath, "utf8");
  const fnMatch = source.match(/function inferProviderName\(modelId\) \{[\s\S]*?\n\}/);
  if (!fnMatch) {
    throw new Error(
      "inferProviderName not found in Stagehand's aisdk.js — patch may need to be regenerated for a new Stagehand version"
    );
  }
  const inferProviderName = new Function(
    "modelId",
    fnMatch[0].replace(/^function inferProviderName\(modelId\) \{/, "").replace(/\}$/, "")
  ) as (modelId: string) => string | undefined;

  it.each([
    ["us.anthropic.claude-opus-5", "anthropic"],
    ["us.anthropic.claude-sonnet-4-6[1m]", "anthropic"],
    ["anthropic.claude-v2", "anthropic"],
    ["anthropic/claude-sonnet-4-5", "anthropic"],
    ["openai/gpt-5", "openai"],
  ])("infers %s as %s", (modelId, expected) => {
    expect(inferProviderName(modelId)).toBe(expected);
  });

  it("does not speculatively map non-Anthropic Bedrock vendors", () => {
    expect(inferProviderName("us.meta.llama3")).toBe("us.meta.llama3");
  });
});
