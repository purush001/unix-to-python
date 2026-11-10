import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reviewerPromptVersion } from '@/agents/agent';
import { ADAPTERS } from '@/adapters';
import { promptVersion } from '@/agents/prompts';
import { costUsd } from '@/lib/cost';
import { ProviderError } from '@/lib/errors';
import { traceTotals } from '@/lib/trace';
import type { LlmProvider, LlmRequest, LlmResponse } from '@/providers/types';
import { createMockLlm } from '@/providers/llm/mock';
import { convert, freshDb, SIMPLE_PLSQL, testProviders } from '../helpers';

/** The mock converter, reporting a real model ID and token usage so cost can be checked. */
function meteredLlm(opts: { failFirst?: ProviderError; model?: string } = {}): LlmProvider & { calls: LlmRequest[] } {
  const mock = createMockLlm();
  const calls: LlmRequest[] = [];
  return {
    name: 'metered',
    calls,
    async complete(req): Promise<LlmResponse> {
      calls.push(req);
      if (opts.failFirst && calls.length === 1) throw opts.failFirst;
      const r = await mock.complete(req);
      return { ...r, model: opts.model ?? 'claude-opus-5-5', stopReason: 'end_turn', usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 100 } };
    },
  };
}

beforeEach(freshDb);
afterEach(() => {
  for (const k of ['MAX_RUN_TOKENS', 'LLM_PRICES', 'LLM_CACHE_TTL']) delete process.env[k];
});

describe('S15 cost', () => {
  it('computes cost per call from usage and the configured price table', () => {
    const usage = { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 100 };
    // (1000*4 + 500*20 + 100*5 + 2000*0.2) / 1e6
    expect(costUsd('claude-opus-5-5', usage)).toBeCloseTo(0.0149, 6);
    process.env.LLM_CACHE_TTL = '1h';
    expect(costUsd('claude-opus-5-5', usage)).toBeCloseTo(0.0152, 6);
  });

  it('reports an unknown price as unknown, never as zero', () => {
    expect(costUsd('claude-some-future-model', { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeNull();
    process.env.LLM_PRICES = 'not json';
    expect(costUsd('claude-opus-5-5', { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeNull();
  });
});

describe('S15 trace', () => {
  it('one run has a span for each stage, model call, retrieval and guardrail, with tokens, cost and latency', async () => {
    const run = await convert(SIMPLE_PLSQL, testProviders({ llm: meteredLlm() }));
    const spans = run.trace ?? [];
    expect(spans.map((s) => s.name)).toEqual(['guardrail.input', 'retrieval', 'llm.generate', 'guardrail.output.scrub', 'stage.generate', 'stage.validate', 'llm.review', 'stage.review', 'guardrail.output.final']);
    for (const s of spans) {
      expect(typeof s.ms).toBe('number');
      expect(s.startedAt).toMatch(/^\d{4}-/);
    }
    const gen = spans.find((s) => s.name === 'llm.generate')!;
    expect(gen.parentId).toBe(spans.find((s) => s.name === 'stage.generate')!.id);
    expect(gen.attrs).toMatchObject({
      'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'claude-opus-5-5', 'gen_ai.response.model': 'claude-opus-5-5', 'gen_ai.response.finish_reasons': ['end_turn'],
      'gen_ai.usage.input_tokens': 3100, 'gen_ai.usage.output_tokens': 500, 'gen_ai.usage.cache_read.input_tokens': 2000, 'gen_ai.usage.cache_creation.input_tokens': 100,
      'app.agent.role': 'sql-agent', 'app.prompt.version': promptVersion(ADAPTERS.plsql.systemPrompt()), 'app.effort': 'high', 'app.attempt': 1,
    });
    expect(gen.attrs['app.cost.usd']).toBeCloseTo(0.0149, 6);
    expect(spans.find((s) => s.name === 'llm.review')!.attrs['app.prompt.version']).toBe(reviewerPromptVersion());
    expect(spans.find((s) => s.name === 'retrieval')!.attrs['app.retrieved.rule_ids']).toEqual(run.units[0].retrieved.rules);
    expect(spans[0].attrs).toMatchObject({ 'app.router.decision': 'sqlplus', 'app.router.method': 'rules' });
    const t = traceTotals(spans);
    expect(t).toMatchObject({ llmCalls: 2, inputTokens: 6200, outputTokens: 1000, unpricedCalls: 0, models: ['claude-opus-5-5'] });
    expect(t.costUsd).toBeCloseTo(0.0298, 6);
  });

  it('never puts script text in a span', async () => {
    const run = await convert(SIMPLE_PLSQL, testProviders({ llm: meteredLlm() }));
    const text = JSON.stringify(run.trace);
    expect(text).not.toContain('PS_NW_TMP');
    expect(text).not.toContain('SERVEROUTPUT');
  });

  it('a failed attempt gets its own span, and the witness records the model, prompt versions and effort', async () => {
    const run = await convert(SIMPLE_PLSQL, testProviders({ llm: meteredLlm({ failFirst: new ProviderError('llm', 'http', 503, 'HTTP 503') }) }));
    const gens = (run.trace ?? []).filter((s) => s.name === 'llm.generate');
    expect(gens.map((s) => [s.status, s.attrs['app.attempt'], s.attrs['error.type'] ?? null])).toEqual([['error', 1, 'http'], ['ok', 2, null]]);
    const w = run.drafts[0].result.witness;
    expect(w.models).toEqual(['claude-opus-5-5']);
    expect(w.promptVersions).toEqual({ 'sql-agent': promptVersion(ADAPTERS.plsql.systemPrompt()), reviewer: reviewerPromptVersion() });
    expect(w.effort).toBe('high');
  });

  it('a call with no configured price makes the run cost unknown', async () => {
    const run = await convert(SIMPLE_PLSQL, testProviders({ llm: meteredLlm({ model: 'claude-some-future-model' }) }));
    expect(traceTotals(run.trace)).toMatchObject({ costUsd: null, unpricedCalls: 2 });
  });
});

describe('S12 token budget', () => {
  it('stops model calls once the run budget is spent and says so', async () => {
    process.env.MAX_RUN_TOKENS = '1000';
    const llm = meteredLlm();
    const run = await convert(SIMPLE_PLSQL, testProviders({ llm }));
    // generate ran (budget not yet spent); the review did not
    expect(llm.calls.map((c) => c.task.kind)).toEqual(['generate']);
    expect(run.drafts[0].result.issues.map((i) => i.code)).toContain('REVIEW_UNAVAILABLE');
  });
});
