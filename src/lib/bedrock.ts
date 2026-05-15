import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";

import type { AppConfig } from "@/config";

/**
 * Builds a Vercel AI SDK LanguageModelV1 backed by AWS Bedrock for
 * injection into Stagehand's llmClient parameter. Centralises all
 * @ai-sdk/amazon-bedrock imports here so no other module touches the AWS SDK.
 *
 * When accessKeyId/secretAccessKey are undefined the AWS SDK falls through
 * to the ambient credential chain (ECS task role, EC2 instance profile,
 * ~/.aws/credentials) — correct for IAM-role deployments.
 */
export function createBedrockModel(
  bedrockConfig: AppConfig["bedrock"]
): ReturnType<ReturnType<typeof createAmazonBedrock>> {
  const provider = createAmazonBedrock({
    region: bedrockConfig.region,
    accessKeyId: bedrockConfig.accessKeyId,
    secretAccessKey: bedrockConfig.secretAccessKey,
    sessionToken: bedrockConfig.sessionToken,
  });

  return provider(bedrockConfig.model);
}
