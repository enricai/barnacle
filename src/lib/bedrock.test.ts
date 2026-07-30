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
