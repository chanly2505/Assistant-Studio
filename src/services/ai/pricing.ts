import type { TokenUsage } from './ai-service';

/**
 * USD per 1M tokens, standard tier.
 * Source: https://developers.openai.com/api/docs/pricing and each model's page,
 * read 2026-09-22. Prices change: re-check when changing AI_MODEL_* settings.
 *
 * USD per 1M tokens equals micro-USD per token, so the numbers below are used
 * directly as micros per token.
 */
export const PRICES_USD_PER_MTOK: Record<
  string,
  { input: number; cachedInput: number; output: number }
> = {
  'gpt-5.6-luna': { input: 0.2, cachedInput: 0.02, output: 1.2 },
  'gpt-5.6-sol': { input: 4, cachedInput: 0.4, output: 20 },
  'gpt-6-astra': { input: 10, cachedInput: 1, output: 50 },
  'gpt-5.4-mini': { input: 0.75, cachedInput: 0.075, output: 4.5 },
};

/**
 * Cost in micro-USD, rounded UP (we would rather over-count spend than under).
 * Returns null — unknown, not free — when the model is not in the table or the
 * provider did not report usage. The spend breaker treats unknown cost as the
 * per-call cap so an unpriced model cannot bypass it.
 *
 * `inputTokens` INCLUDES cached tokens (OpenAI reports cached as a subset), so
 * the uncached part is billed at the full rate and the cached part at the
 * cached rate.
 */
export function costMicros(model: string, usage: TokenUsage): number | null {
  const price = PRICES_USD_PER_MTOK[model];
  if (!price || !usage.reported) return null;

  const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const uncached = usage.inputTokens - cached;
  return Math.ceil(
    uncached * price.input + cached * price.cachedInput + usage.outputTokens * price.output,
  );
}

/** Worst case for one call, used when the real cost is unknown. */
export function maxCostMicros(
  model: string,
  maxOutputTokens: number,
  maxInputTokens = 8_000,
): number {
  const price = PRICES_USD_PER_MTOK[model] ?? { input: 10, cachedInput: 1, output: 50 };
  return Math.ceil(maxInputTokens * price.input + maxOutputTokens * price.output);
}
