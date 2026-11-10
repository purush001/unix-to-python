import Anthropic from '@anthropic-ai/sdk';
import { getConfig, getConfigInt, requireSecret } from '@/config/env';
import { ProviderError } from '@/lib/errors';
import type { LlmProvider, LlmRequest, LlmResponse, LlmUsage } from '../types';

type StreamParams = Parameters<Anthropic['beta']['messages']['stream']>[0];

/**
 * S3. Claude through the official SDK. This is the only file that imports the SDK.
 *
 * - The client is created inside complete() so no API key outlives the request.
 * - Model, effort, token cap, cache lifetime and the fallback beta come from configuration.
 * - SDK retries are off: the pipeline owns retries. Output is streamed; one timeout per call.
 * - The system prompt is stable, so it is sent first and marked for prompt caching.
 * - Thinking is adaptive (the only mode this model accepts); depth is set with effort.
 * - No tools are sent, so `tool_choice` is never used.
 * - Every stop reason is handled explicitly (see finish()).
 */
export function createAnthropicLlm(): LlmProvider {
  return {
    name: 'anthropic',
    async complete(req: LlmRequest): Promise<LlmResponse> {
      const client = new Anthropic({ apiKey: requireSecret('ANTHROPIC_API_KEY'), maxRetries: 0, timeout: req.timeoutMs });
      const model = req.model ?? getConfig('LLM_MODEL');
      const ttl = getConfig('LLM_CACHE_TTL');
      const beta = getConfig('LLM_FALLBACK_BETA');
      const system = [{ type: 'text', text: req.system, ...(ttl === 'off' ? {} : { cache_control: { type: 'ephemeral', ...(ttl === '1h' ? { ttl: '1h' } : {}) } }) }];
      // append-only: a paused turn is resumed by sending the assistant content back unmodified
      const messages: unknown[] = [{ role: 'user', content: req.user }];
      const usage: LlmUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      const maxContinuations = getConfigInt('LLM_MAX_CONTINUATIONS');
      try {
        for (let continuations = 0; ; continuations++) {
          const stream = client.beta.messages.stream({
            model,
            max_tokens: req.maxTokens,
            thinking: { type: 'adaptive' },
            output_config: { effort: getConfig('LLM_EFFORT') },
            ...(beta !== 'off' ? { betas: [beta], fallbacks: 'default' } : {}),
            system,
            messages,
          } as unknown as StreamParams);
          const msg = await stream.finalMessage();
          const u = msg.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
          usage.inputTokens += u.input_tokens ?? 0;
          usage.outputTokens += u.output_tokens ?? 0;
          usage.cacheReadTokens += u.cache_read_input_tokens ?? 0;
          usage.cacheWriteTokens += u.cache_creation_input_tokens ?? 0;
          const stop = msg.stop_reason as string | null;
          if (stop === 'pause_turn') {
            // a long server-side turn paused: resume it, up to the configured number of times
            if (continuations >= maxContinuations) throw new ProviderError('anthropic', 'malformed', 200, `Model turn was still paused after ${maxContinuations} continuations`);
            messages.push({ role: 'assistant', content: msg.content });
            continue;
          }
          return finish(msg, stop, usage, continuations);
        }
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

function finish(msg: { content: { type: string; text?: string }[]; model: string; stop_details?: unknown }, stop: string | null, usage: LlmUsage, continuations: number): LlmResponse {
  if (stop === 'refusal') {
    // HTTP 200 with stop_reason "refusal": surfaced as a refusal, never retried blindly
    const d = (msg.stop_details ?? null) as { category?: string | null } | null;
    const category = typeof d?.category === 'string' ? d.category : null;
    throw new ProviderError('anthropic', 'refusal', 422, `The model declined this request${category ? ` (category: ${category})` : ''}`, category);
  }
  if (stop === 'max_tokens') throw new ProviderError('anthropic', 'malformed', 200, 'Model output was cut off at max_tokens');
  // no tools are sent, so a tool call cannot be executed: the reply is unusable
  if (stop === 'tool_use') throw new ProviderError('anthropic', 'malformed', 200, 'Model asked for a tool, but this application sends none');
  if (stop !== 'end_turn' && stop !== 'stop_sequence') throw new ProviderError('anthropic', 'malformed', 200, `Model stopped for an unexpected reason (${String(stop)})`);
  // select content by type, never by position (thinking and fallback blocks come first)
  const text = msg.content.map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('');
  if (!text.trim()) throw new ProviderError('anthropic', 'empty', 200, 'Model returned no text');
  return { text, status: 200, model: msg.model, usage, stopReason: stop, continuations };
}
