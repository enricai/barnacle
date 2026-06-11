"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createBedrockModel = createBedrockModel;
const amazon_bedrock_1 = require("@ai-sdk/amazon-bedrock");
/**
 * Builds an AI SDK language model backed by AWS Bedrock for injection into
 * Stagehand's `llmClient`. Centralises all @ai-sdk/amazon-bedrock imports here
 * so no other module touches the AWS SDK.
 *
 * Bedrock v4 emits a `LanguageModelV3` (provider spec v3) but Stagehand's
 * `AISdkClient` still types its `model` as `LanguageModelV2`. The two specs
 * are runtime-compatible for Stagehand's use, so we cast at this single
 * boundary rather than letting the version mismatch leak into call sites.
 * Remove the cast once Stagehand accepts `LanguageModelV3`.
 *
 * When accessKeyId/secretAccessKey are set, uses explicit static credentials.
 * When omitted, region-only config lets the SDK fall through to its default
 * credential chain (env vars → ~/.aws/credentials → ECS task role → EC2
 * instance profile) — correct for IAM-role deployments.
 */
function createBedrockModel(bedrockConfig) {
    const hasExplicitCredentials = bedrockConfig.accessKeyId !== undefined && bedrockConfig.secretAccessKey !== undefined;
    const provider = (0, amazon_bedrock_1.createAmazonBedrock)({
        region: bedrockConfig.region,
        ...(hasExplicitCredentials
            ? {
                accessKeyId: bedrockConfig.accessKeyId,
                secretAccessKey: bedrockConfig.secretAccessKey,
                ...(bedrockConfig.sessionToken ? { sessionToken: bedrockConfig.sessionToken } : {}),
            }
            : {}),
    });
    return provider(bedrockConfig.model);
}
//# sourceMappingURL=bedrock.js.map