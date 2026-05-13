import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";

import type { AppConfig } from "@/config";

/**
 * Builds a Vercel AI SDK LanguageModelV2 backed by AWS Bedrock for
 * injection into Stagehand's llmClient parameter. Centralises all
 * @ai-sdk/amazon-bedrock imports here so no other module touches the AWS SDK.
 *
 * When accessKeyId/secretAccessKey are set, uses explicit static credentials.
 * When omitted, region-only config lets the SDK fall through to its default
 * credential chain (env vars → ~/.aws/credentials → ECS task role → EC2
 * instance profile) — correct for IAM-role deployments.
 */
export function createBedrockModel(
  bedrockConfig: AppConfig["bedrock"]
): ReturnType<ReturnType<typeof createAmazonBedrock>> {
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
