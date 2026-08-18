import { createAnthropic } from "@ai-sdk/anthropic";
import Anthropic from "@anthropic-ai/sdk";
import type { LanguageModel } from "ai";

import { config } from "@/config";
import { createBedrockModel } from "@/lib/bedrock";

/**
 * The rephrase call chain's own model type, derived from `ai`'s
 * provider-agnostic `LanguageModel` union rather than reusing bedrock.ts's
 * `StagehandModel` (pinned to `LanguageModelV2` for its `AISdkClient`
 * consumers). Excludes the bare-modelId-string variant so only
 * object-shaped models with a `.modelId` field remain.
 */
export type RephraseModel = Exclude<LanguageModel, string>;

/**
 * Build the shared Anthropic client used by the self-heal cascade's LLM
 * techniques (attempt-5 rephrase, replan, judges). Returns `null` on a
 * Bedrock-only deployment or when no `ANTHROPIC_API_KEY` is configured, so
 * callers degrade to deterministic-only healing instead of crashing. Extracted
 * to a leaf module so every entrypoint — the recon CLI, the heal loops, and
 * generated site plugins running {@link runHealingFlow} — resolves the client
 * the same way rather than each duplicating the env/Bedrock gate.
 */
export function buildAnthropicClient(): Anthropic | null {
  if (config.scraper.useBedrock || !config.scraper.anthropicApiKey) return null;
  return new Anthropic({ apiKey: config.scraper.anthropicApiKey });
}

/**
 * Build the provider-agnostic ai-SDK model used by `rephraseWithLLM`'s
 * attempt-5 structured-output call. Unlike {@link buildAnthropicClient},
 * this never returns `null` on a Bedrock-only deployment — it resolves to
 * the Bedrock-backed model (same as the primary act/observe path via
 * `createBedrockModel`) instead of degrading, so Bedrock-only deployments
 * get the same rephrase tier Anthropic-direct deployments already have.
 * Returns `null` only when neither Bedrock nor a direct Anthropic key is
 * configured at all.
 */
export function buildRephraseModel(): RephraseModel | null {
  if (config.scraper.useBedrock) return createBedrockModel(config.bedrock);
  if (!config.scraper.anthropicApiKey) return null;
  const provider = createAnthropic({ apiKey: config.scraper.anthropicApiKey });
  const rawModel = config.scraper.model;
  const modelId = rawModel.startsWith("anthropic/")
    ? rawModel.slice("anthropic/".length)
    : rawModel;
  return provider.languageModel(modelId);
}
