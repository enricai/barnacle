import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import type { AISdkClient } from "@browserbasehq/stagehand";

import type { AppConfig } from "@/config";

type StagehandModel = ConstructorParameters<typeof AISdkClient>[0]["model"];

/**
 * Builds an AI SDK language model backed by AWS Bedrock for injection into
 * Stagehand's `llmClient`. Centralises all @ai-sdk/amazon-bedrock imports here
 * so no other module touches the AWS SDK.
 *
 * Pinned to the @ai-sdk/amazon-bedrock 3.x line, not the latest 5.x: 5.x
 * emits `LanguageModelV4`, but the `ai` version Stagehand's `AISdkClient`
 * depends on only accepts `specificationVersion: "v2"` and throws
 * `AI_UnsupportedModelVersionError` otherwise. 3.x emits `LanguageModelV2`,
 * matching both Stagehand's dependency and `ai`'s runtime check exactly —
 * the same provider-spec version Stagehand itself pins as an optional
 * dependency. Bump past 3.x only once Stagehand's `ai` dependency accepts
 * newer provider specs.
 *
 * When accessKeyId/secretAccessKey are set, uses explicit static credentials.
 * When omitted, region-only config lets the SDK fall through to its default
 * credential chain (env vars → ~/.aws/credentials → ECS task role → EC2
 * instance profile) — correct for IAM-role deployments.
 */
export function createBedrockModel(bedrockConfig: AppConfig["bedrock"]): StagehandModel {
  const hasExplicitCredentials =
    bedrockConfig.accessKeyId !== undefined && bedrockConfig.secretAccessKey !== undefined;

  const provider = createAmazonBedrock({
    region: bedrockConfig.region,
    ...(hasExplicitCredentials
      ? {
          accessKeyId: bedrockConfig.accessKeyId as string,
          secretAccessKey: bedrockConfig.secretAccessKey as string,
          ...(bedrockConfig.sessionToken ? { sessionToken: bedrockConfig.sessionToken } : {}),
        }
      : {}),
  });

  return provider(bedrockConfig.model);
}
