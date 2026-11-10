import Anthropic from '@anthropic-ai/sdk';
import { getConfig, requireSecret } from '@/config/env';
import { ProviderError } from '@/lib/errors';
import type { LlmProvider, LlmRequest, LlmResponse } from '../types';

/**
 * Claude through the official SDK. The client is created inside complete() so no
 * API key outlives the request. SDK retries are off: the pipeline owns retries.
 * Refusals fall back server-side (fallbacks: "default").
 */
export function createAnthropicLlm(): LlmProvider {
  return {
    name: 'anthropic',
    async complete(req: LlmRequest): Promise<LlmResponse> {
      const client = new Anthropic({ apiKey: requireSecret('ANTHROPIC_API_KEY'), maxRetries: 0, timeout: req.timeoutMs });
      const model = getConfig('LLM_MODEL');
      try {
        const stream = client.beta.messages.stream({
          model,
          max_tokens: req.maxTokens ?? 32000,
          thinking: { type: 'adaptive' },
          output_config: { effort: 'high' },
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          system: req.system,
          messages: [{ role: 'user', content: req.user }],
        } as Parameters<typeof client.beta.messages.stream>[0]);
        const msg = await stream.finalMessage();
        if (msg.stop_reason === 'refusal') throw new ProviderError('anthropic', 'http', 422, 'The model declined this request');
        if (msg.stop_reason === 'max_tokens') throw new ProviderError('anthropic', 'malformed', 200, 'Model output was cut off at max_tokens');
        const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
        if (!text.trim()) throw new ProviderError('anthropic', 'empty', 200, 'Model returned no text');
        return { text, status: 200, model: msg.model, usage: { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens } };
      } catch (e) {
        if (e instanceof ProviderError) throw e;
        if (e instanceof Anthropic.APIConnectionTimeoutError) throw new ProviderError('anthropic', 'timeout', 504, 'Model call timed out');
        if (e instanceof Anthropic.APIConnectionError) throw new ProviderError('anthropic', 'network', 502, 'Could not reach the model provider');
        if (e instanceof Anthropic.APIError && typeof e.status === 'number') throw new ProviderError('anthropic', 'http', e.status, `Model provider returned HTTP ${e.status}`);
        throw new ProviderError('anthropic', 'network', 502, e instanceof Error ? e.message : 'Unknown model provider error');
      }
    },
  };
}
