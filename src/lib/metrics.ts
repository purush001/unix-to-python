import { percentile } from '@/lib/util';
import type { StatusView } from '@/lib/api-types';
import type { Feedback, LogEntry, RunRecord, SkillRule } from '@/pipeline/types';

/** Aggregates the observability metrics of section 18 from stored runs, logs, feedback and rules. */
export function computeMetrics(runs: RunRecord[], logs: LogEntry[], feedback: Feedback[], rules: SkillRule[], pendingIndexWrites: number): StatusView['metrics'] {
  const runsByState: Record<string, number> = {};
  const durations: Record<string, number[]> = {};
  const failuresByCode: Record<string, number> = {};
  let repaired = 0;
  let withRetries = 0;
  let saveFailures = 0;
  const withDraft = runs.filter((r) => r.drafts.length > 0);
  for (const r of runs) {
    runsByState[r.state] = (runsByState[r.state] ?? 0) + 1;
    for (const s of r.stageLog) (durations[s.stage] ??= []).push(s.ms);
    if (r.error) failuresByCode[r.error.code] = (failuresByCode[r.error.code] ?? 0) + 1;
    const d = r.drafts[r.drafts.length - 1];
    if (!d) continue;
    if (d.result.attempts > 0) repaired++;
    if (d.result.witness.transientRetries > 0) withRetries++;
    if (d.result.status === 'failed') for (const c of new Set(d.result.issues.filter((i) => i.severity === 'error').map((i) => i.code))) failuresByCode[c] = (failuresByCode[c] ?? 0) + 1;
  }
  const ratingDistribution: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
  for (const f of feedback) if (f.rating) ratingDistribution[String(f.rating)]++;
  const retrievals = logs.filter((l) => l.msg === 'memory retrieval');
  const num = (v: unknown) => (typeof v === 'number' ? v : 0);
  // counted from the log so a later successful retry does not hide the failure
  saveFailures = Math.max(logs.filter((l) => l.msg === 'github save failed').length, runs.filter((r) => r.save?.status === 'failed').length);
  return {
    runsByState,
    stageDurations: Object.fromEntries(Object.entries(durations).map(([k, v]) => [k, { p50: percentile(v, 50), p95: percentile(v, 95), count: v.length }])),
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
  };
}
