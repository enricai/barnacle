import type { AISdkClient } from "@browserbasehq/stagehand";
import type { AppConfig } from "../config";
type StagehandModel = ConstructorParameters<typeof AISdkClient>[0]["model"];
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
export declare function createBedrockModel(bedrockConfig: AppConfig["bedrock"]): StagehandModel;
export {};
