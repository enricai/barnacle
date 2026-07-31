import Anthropic from "@anthropic-ai/sdk";

import { config } from "@/config";

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
