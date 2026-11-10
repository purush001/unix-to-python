import { percentile } from '@/lib/util';
import type { StatusView } from '@/lib/api-types';
import { traceTotals } from '@/lib/trace';
import type { Feedback, LogEntry, RunRecord, SkillRule, Span } from '@/pipeline/types';

const num = (v: unknown) => (typeof v === 'number' ? v : 0);
const DAY_MS = 86400000;

/** Runs where an output guardrail stripped or blocked a protected item. */
const leakSpans = (spans: Span[] | undefined) => (spans ?? []).filter((s) => s.kind === 'guardrail' && s.name !== 'guardrail.input' && s.status === 'error');

/**
 * S15. Dashboard metrics from stored runs (including their traces), logs, feedback and rules:
 * volume, success rate, latency, tokens and cost, repair and retry rates, guardrail block
 * rate, judge scores, rating distribution, top issue codes, cache hit rate and rate-limit responses.
 */
export function computeMetrics(runs: RunRecord[], logs: LogEntry[], feedback: Feedback[], rules: SkillRule[], pendingIndexWrites: number, now = Date.now()): StatusView['metrics'] {
  const runsByState: Record<string, number> = {};
  const durations: Record<string, number[]> = {};
  const llmMs: Record<string, number[]> = {};
  const failuresByCode: Record<string, number> = {};
  const issueCounts: Record<string, number> = {};
  const costByModel: Record<string, { calls: number; costUsd: number | null }> = {};
  const costByDay: Record<string, { runs: number; costUsd: number | null }> = {};
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const judgeFailed: Record<string, number> = {};
  const judgeScores: number[] = [];
  let repaired = 0;
  let withRetries = 0;
  let cost: number | null = 0;
  let unpriced = 0;
  let outputStripped = 0;
  let commitBlocked = 0;
  const withDraft = runs.filter((r) => r.drafts.length > 0);
  const recent = runs.filter((r) => now - Date.parse(r.createdAt) <= DAY_MS);
  for (const r of runs) {
    runsByState[r.state] = (runsByState[r.state] ?? 0) + 1;
    for (const s of r.stageLog) (durations[s.stage] ??= []).push(s.ms);
    if (r.error) failuresByCode[r.error.code] = (failuresByCode[r.error.code] ?? 0) + 1;
    const t = traceTotals(r.trace);
    tokens.input += t.inputTokens;
    tokens.output += t.outputTokens;
    tokens.cacheRead += t.cacheReadTokens;
    tokens.cacheWrite += t.cacheWriteTokens;
    unpriced += t.unpricedCalls;
    if (t.costUsd === null) cost = null;
    else if (cost !== null) cost += t.costUsd;
    const day = r.createdAt.slice(0, 10);
    const d0 = (costByDay[day] ??= { runs: 0, costUsd: 0 });
    d0.runs++;
    d0.costUsd = d0.costUsd === null || t.costUsd === null ? null : Number((d0.costUsd + t.costUsd).toFixed(6));
    for (const s of r.trace ?? []) {
      if (s.kind === 'llm') {
        (llmMs[s.name] ??= []).push(s.ms);
        const model = typeof s.attrs['gen_ai.response.model'] === 'string' ? (s.attrs['gen_ai.response.model'] as string) : 'unknown';
        const m = (costByModel[model] ??= { calls: 0, costUsd: 0 });
        m.calls++;
        const c = s.attrs['app.cost.usd'];
        m.costUsd = m.costUsd === null || typeof c !== 'number' ? (s.attrs['gen_ai.usage.input_tokens'] == null ? m.costUsd : null) : Number((m.costUsd + c).toFixed(6));
      }
      if (s.name === 'guardrail.output.scrub' && s.status === 'error') outputStripped++;
      if (s.name === 'guardrail.commit' && s.status === 'error') commitBlocked++;
    }
    if (r.judge) {
      if (r.judge.score !== null) judgeScores.push(r.judge.score);
      for (const c of r.judge.criteria) if (c.verdict === 'no') judgeFailed[c.id] = (judgeFailed[c.id] ?? 0) + 1;
    }
    const d = r.drafts[r.drafts.length - 1];
    if (!d) continue;
    if (d.result.attempts > 0) repaired++;
    if (d.result.witness.transientRetries > 0) withRetries++;
    for (const c of new Set(d.result.issues.map((i) => i.code))) issueCounts[c] = (issueCounts[c] ?? 0) + 1;
    if (d.result.status === 'failed') for (const c of new Set(d.result.issues.filter((i) => i.severity === 'error').map((i) => i.code))) failuresByCode[c] = (failuresByCode[c] ?? 0) + 1;
  }
  const ratingDistribution: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
  for (const f of feedback) if (f.rating) ratingDistribution[String(f.rating)]++;
  const retrievals = logs.filter((l) => l.msg === 'memory retrieval');
  // counted from the log so a later successful retry does not hide the failure
  const saveFailLogs = logs.filter((l) => l.msg === 'github save failed');
  const saveFailures = Math.max(saveFailLogs.length, runs.filter((r) => r.save?.status === 'failed').length);
  const inputRejected: Record<string, number> = {};
  for (const l of logs) if (l.msg === 'input rejected') inputRejected[String(l.data.code)] = (inputRejected[String(l.data.code)] ?? 0) + 1;
  const rejected = Object.values(inputRejected).reduce((a, b) => a + b, 0);
  const pct = (v: Record<string, number[]>) => Object.fromEntries(Object.entries(v).map(([k, x]) => [k, { p50: percentile(x, 50), p95: percentile(x, 95), count: x.length }]));
  const totalInput = tokens.input;
  const succeeded = runs.filter((r) => r.drafts.length > 0 && r.drafts[r.drafts.length - 1].result.status !== 'failed').length;

  // last 24 hours, for alerts
  const recentTotals = recent.map((r) => traceTotals(r.trace));
  const recentGen = recent.flatMap((r) => r.stageLog.filter((s) => s.stage === 'generate').map((s) => s.ms));
  const recentJudge = recent.filter((r) => r.judge && r.judge.score !== null).map((r) => r.judge!.score as number);
  const recentUnpriced = recentTotals.reduce((s, t) => s + t.unpricedCalls, 0);
  return {
    runsByState,
    stageDurations: pct(durations),
    repairRate: withDraft.length ? repaired / withDraft.length : 0,
    transientRetryRate: withDraft.length ? withRetries / withDraft.length : 0,
    failuresByCode,
    ratingDistribution,
    githubSaveFailures: saveFailures,
    rulesPromoted: rules.filter((r) => r.status === 'promoted').length,
    rulesRejected: rules.filter((r) => r.status === 'rejected').length,
    memory: {
      retrievals: retrievals.length,
      avgLatencyMs: retrievals.length ? Math.round(retrievals.reduce((s, l) => s + num(l.data.ms), 0) / retrievals.length) : 0,
      avgRuleHits: retrievals.length ? Number((retrievals.reduce((s, l) => s + num(l.data.ruleHits), 0) / retrievals.length).toFixed(2)) : 0,
      unavailable: retrievals.filter((l) => l.data.unavailable === true).length,
      pendingIndexWrites,
    },
    volume: runs.length,
    successRate: runs.length ? succeeded / runs.length : 0,
    tokens,
    cacheHitRate: totalInput ? Number((tokens.cacheRead / totalInput).toFixed(4)) : null,
    costUsd: cost === null ? null : Number(cost.toFixed(6)),
    unpricedCalls: unpriced,
    costByModel,
    costByDay,
    llmLatency: pct(llmMs),
    guardrails: { inputRejected, inputBlockRate: runs.length + rejected ? rejected / (runs.length + rejected) : 0, outputStripped, commitBlocked },
    rateLimited: logs.filter((l) => l.msg === 'rate limited').length,
    topIssueCodes: Object.entries(issueCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10),
    judge: { judged: runs.filter((r) => r.judge).length, meanScore: judgeScores.length ? Number((judgeScores.reduce((a, b) => a + b, 0) / judgeScores.length).toFixed(4)) : null, failedCriteria: judgeFailed },
    last24h: {
      runs: recent.length,
      failedRuns: recent.filter((r) => r.state === 'failed' || r.drafts[r.drafts.length - 1]?.result.status === 'failed').length,
      p95GenerateMs: recentGen.length ? percentile(recentGen, 95) : null,
      costUsd: recentTotals.reduce((s, t) => s + (t.costUsd ?? 0), 0),
      unpricedCalls: recentUnpriced,
      guardrailLeaks: recent.filter((r) => leakSpans(r.trace).length > 0).length,
      judgeMeanScore: recentJudge.length ? Number((recentJudge.reduce((a, b) => a + b, 0) / recentJudge.length).toFixed(4)) : null,
      judgedRuns: recentJudge.length,
      saveFailures: Math.max(saveFailLogs.filter((l) => now - Date.parse(l.ts) <= DAY_MS).length, recent.filter((r) => r.save?.status === 'failed').length),
    },
  };
}
