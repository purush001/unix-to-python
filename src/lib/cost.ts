import { getConfig } from '@/config/env';
import type { LlmUsage } from '@/providers/types';

/** USD per million tokens: [input, output, cache write 5m, cache write 1h, cache read]. */
type Price = [number, number, number, number, number];

function priceTable(): Record<string, Price> {
  try {
    const t = JSON.parse(getConfig('LLM_PRICES')) as Record<string, unknown>;
    const out: Record<string, Price> = {};
    for (const [model, p] of Object.entries(t)) if (Array.isArray(p) && p.length === 5 && p.every((n) => typeof n === 'number' && n >= 0)) out[model] = p as Price;
    return out;
  } catch {
    return {};
  }
}

/**
 * S15. Cost of one model call from its usage and the configured price table. Returns null
 * when the answering model has no price: an unknown price is reported as unknown, never as 0.
 */
export function costUsd(model: string, usage: LlmUsage | undefined): number | null {
  if (!usage) return null;
  const p = priceTable()[model];
  if (!p) return null;
  const write = getConfig('LLM_CACHE_TTL') === '1h' ? p[3] : p[2];
  const usd = (usage.inputTokens * p[0] + usage.outputTokens * p[1] + usage.cacheWriteTokens * write + usage.cacheReadTokens * p[4]) / 1_000_000;
  return Number(usd.toFixed(6));
}

export const totalTokens = (u: LlmUsage | undefined): number => (u ? u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens : 0);
