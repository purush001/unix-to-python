import { randomBytes } from 'node:crypto';
import { getConfig } from '@/config/env';
import { costUsd } from '@/lib/cost';
import { ProviderError } from '@/lib/errors';
import { nowIso } from '@/lib/util';
import type { RunRecord, Span, SpanAttr, SpanKind } from '@/pipeline/types';
import type { LlmResponse, LlmUsage } from '@/providers/types';

/**
 * S15. One trace per run: the trace ID is the run ID, and every stage, model call,
 * retrieval and guardrail adds a span. Spans hold IDs, counts, codes and hashes only,
 * never script text. Attribute names follow the OpenTelemetry GenAI conventions where one
 * exists (`gen_ai.*`); application attributes use the `app.*` prefix.
 */
export const newSpanId = (): string => randomBytes(6).toString('hex');

export function addSpan(run: RunRecord, s: { id?: string; parentId?: string | null; name: string; kind: SpanKind; unitId?: string | null; startedAt: string; ms: number; status?: 'ok' | 'error'; attrs?: Record<string, SpanAttr | undefined> }): Span {
  const attrs: Record<string, SpanAttr> = {};
  for (const [k, v] of Object.entries(s.attrs ?? {})) if (v !== undefined) attrs[k] = v;
  const span: Span = { id: s.id ?? newSpanId(), parentId: s.parentId ?? null, name: s.name, kind: s.kind, unitId: s.unitId ?? null, startedAt: s.startedAt, ms: s.ms, status: s.status ?? 'ok', attrs };
  (run.trace ??= []).push(span);
  return span;
}

export interface LlmSpanInput {
  role: string;
  operation: string;
  promptVersion: string;
  requestModel: string;
  maxTokens: number;
  attempt: number;
  parentId: string | null;
  unitId: string | null;
  startedAt: string;
  ms: number;
}

/** Records one model call attempt, successful or not, with tokens and cost. */
export function addLlmSpan(run: RunRecord, i: LlmSpanInput, result: LlmResponse | unknown): Span {
  const ok = !(result instanceof Error);
  const err = result instanceof ProviderError ? result : null;
  const res = ok ? (result as LlmResponse) : err?.response;
  const usage: LlmUsage | undefined = res?.usage;
  const model = res?.model ?? null;
  return addSpan(run, {
    parentId: i.parentId, name: `llm.${i.operation}`, kind: 'llm', unitId: i.unitId, startedAt: i.startedAt, ms: i.ms, status: ok ? 'ok' : 'error',
    attrs: {
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': i.requestModel,
      'gen_ai.response.model': model,
      'gen_ai.request.max_tokens': i.maxTokens,
      'gen_ai.response.finish_reasons': res?.stopReason ? [res.stopReason] : err?.failure === 'refusal' ? ['refusal'] : null,
      // total input = uncached + cache read + cache write
      'gen_ai.usage.input_tokens': usage ? usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens : null,
      'gen_ai.usage.output_tokens': usage?.outputTokens ?? null,
      'gen_ai.usage.cache_read.input_tokens': usage?.cacheReadTokens ?? null,
      'gen_ai.usage.cache_creation.input_tokens': usage?.cacheWriteTokens ?? null,
      'app.agent.role': i.role,
      'app.prompt.version': i.promptVersion,
      'app.effort': getConfig('LLM_EFFORT'),
      'app.cost.usd': model ? costUsd(model, usage) : null,
      'app.attempt': i.attempt,
      'app.continuations': ok ? ((result as LlmResponse).continuations ?? 0) : undefined,
      'error.type': ok ? undefined : err ? err.failure : 'internal',
      'app.provider.status': err ? err.status : undefined,
      'app.refusal.category': err?.failure === 'refusal' ? err.category : undefined,
    },
  });
}

export interface TraceTotals {
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** null when at least one call had no price. */
  costUsd: number | null;
  unpricedCalls: number;
  models: string[];
}

const n = (v: SpanAttr | undefined): number => (typeof v === 'number' ? v : 0);

export function traceTotals(spans: Span[] | undefined): TraceTotals {
  const t: TraceTotals = { llmCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, unpricedCalls: 0, models: [] };
  let cost = 0;
  for (const s of spans ?? []) {
    if (s.kind !== 'llm') continue;
    t.llmCalls++;
    t.inputTokens += n(s.attrs['gen_ai.usage.input_tokens']);
    t.outputTokens += n(s.attrs['gen_ai.usage.output_tokens']);
    t.cacheReadTokens += n(s.attrs['gen_ai.usage.cache_read.input_tokens']);
    t.cacheWriteTokens += n(s.attrs['gen_ai.usage.cache_creation.input_tokens']);
    const c = s.attrs['app.cost.usd'];
    if (typeof c === 'number') cost += c;
    else if (s.attrs['gen_ai.usage.input_tokens'] !== null && s.attrs['gen_ai.usage.input_tokens'] !== undefined) t.unpricedCalls++;
    const m = s.attrs['gen_ai.response.model'];
    if (typeof m === 'string' && !t.models.includes(m)) t.models.push(m);
  }
  t.costUsd = t.unpricedCalls ? null : Number(cost.toFixed(6));
  return t;
}

/** Tokens the run has spent so far (input + output), for the run token budget. */
export const tokensSpent = (run: RunRecord): number => {
  const t = traceTotals(run.trace);
  return t.inputTokens + t.outputTokens;
};

export const spanClock = () => ({ startedAt: nowIso(), t0: Date.now() });
