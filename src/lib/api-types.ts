import type { Issue } from '@/pipeline/issue-codes';
import { ISSUE_CATALOGUE } from '@/pipeline/issue-codes';
import type { Alert } from '@/lib/alerts';
import { traceTotals, type TraceTotals } from '@/lib/trace';
import type { Change, JudgeScore, OutputFile, Platform, ProgressEvent, RunRecord, RunState, SanitizeCounts, ScriptType, Span, StageName, Suggestion, Witness } from '@/pipeline/types';
import { countSummary } from '@/sanitizer/summary';

export interface IssueView extends Issue {
  explanation: string;
  nextStep: string;
}
export interface DraftView {
  version: number;
  createdAt: string;
  note: string | null;
  status: 'ok' | 'ok_with_warnings' | 'failed';
  files: OutputFile[];
  issues: IssueView[];
  changes: Change[];
  suggestions: Suggestion[];
  attempts: number;
  /** Indexes of change-list items and warnings the reviewer removed from view. */
  dismissed: { changes: number[]; issues: number[] };
  /** The file a person edited to make this version, if any. */
  editedFile: string | null;
}
export interface RunView {
  id: string;
  state: RunState;
  /** True when the pipeline stopped at the request time budget; POST /api/runs/:id/resume continues it. */
  resumable: boolean;
  scriptType: ScriptType;
  platform: Platform;
  createdAt: string;
  updatedAt: string;
  sanitizedSource: string;
  sanitization: { counts: SanitizeCounts; summary: string; warnings: IssueView[]; highlightLines: number[] };
  drafts: DraftView[];
  reviewerNotes: { at: string; note: string }[];
  stages: { stage: StageName; unitId: string | null; at: string; ms: number }[];
  final: { version: number; approvedAt: string } | null;
  save: RunRecord['save'];
  rating: RunRecord['rating'];
  error: RunRecord['error'];
}
export type StreamEvent = ProgressEvent | { type: 'result'; run: RunView } | { type: 'error'; error: { code: string; message: string; status: number; runId?: string } };

export interface StatusView {
  providers: Record<string, 'mock' | 'real'>;
  runs: { id: string; state: RunState; scriptType: ScriptType; platform: Platform; createdAt: string; status: string | null; attempts: number; rating: number | null }[];
  metrics: {
    runsByState: Record<string, number>;
    stageDurations: Record<string, { p50: number; p95: number; count: number }>;
    repairRate: number;
    transientRetryRate: number;
    failuresByCode: Record<string, number>;
    ratingDistribution: Record<string, number>;
    githubSaveFailures: number;
    rulesPromoted: number;
    rulesRejected: number;
    memory: { retrievals: number; avgLatencyMs: number; avgRuleHits: number; unavailable: number; pendingIndexWrites: number };
    volume: number;
    successRate: number;
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
    /** Share of input tokens served from the prompt cache. */
    cacheHitRate: number | null;
    /** null when a call had no configured price. */
    costUsd: number | null;
    unpricedCalls: number;
    costByModel: Record<string, { calls: number; costUsd: number | null }>;
    costByDay: Record<string, { runs: number; costUsd: number | null }>;
    llmLatency: Record<string, { p50: number; p95: number; count: number }>;
    guardrails: { inputRejected: Record<string, number>; inputBlockRate: number; outputStripped: number; commitBlocked: number };
    rateLimited: number;
    topIssueCodes: [string, number][];
    judge: { judged: number; meanScore: number | null; failedCriteria: Record<string, number> };
    last24h: { runs: number; failedRuns: number; p95GenerateMs: number | null; costUsd: number | null; unpricedCalls: number; guardrailLeaks: number; judgeMeanScore: number | null; judgedRuns: number; saveFailures: number };
  };
  alerts: Alert[];
  rules: { id: string; platform: Platform; status: string; version: number; trigger: string[]; guidance: string; sourceRunId: string | null; rejectReason: string | null; witness: unknown }[];
}

export interface TraceView {
  /** The trace ID is the run ID. */
  traceId: string;
  state: RunState;
  platform: Platform;
  scriptType: ScriptType;
  createdAt: string;
  totals: TraceTotals;
  spans: Span[];
  /** Scores attached to the trace: the user's rating and the live judge's verdict. */
  scores: { userRating: number | null; judge: JudgeScore | null };
  /** The latest draft's witness: hashes, versions, codes per stage and retrieved IDs. No script text. */
  witness: Witness | null;
}

export function toTraceView(run: RunRecord): TraceView {
  const w = run.drafts[run.drafts.length - 1]?.result.witness;
  return {
    traceId: run.id, state: run.state, platform: run.platform, scriptType: run.scriptType, createdAt: run.createdAt,
    totals: traceTotals(run.trace), spans: run.trace ?? [],
    scores: { userRating: run.rating?.rating ?? null, judge: run.judge ?? null },
    witness: w ? { ...w, models: w.models ?? [], promptVersions: w.promptVersions ?? {}, effort: w.effort ?? '' } : null,
  };
}

const view = (i: Issue): IssueView => ({ ...i, explanation: ISSUE_CATALOGUE[i.code].explanation, nextStep: ISSUE_CATALOGUE[i.code].nextStep });

export function toRunView(run: RunRecord): RunView {
  return {
    id: run.id, state: run.state, resumable: run.state === 'drafting', scriptType: run.scriptType, platform: run.platform, createdAt: run.createdAt, updatedAt: run.updatedAt,
    sanitizedSource: run.sanitizedSource,
    sanitization: { counts: run.sanitization.counts, summary: countSummary(run.sanitization.counts), warnings: run.sanitization.warnings.map(view), highlightLines: run.sanitization.highlightLines },
    drafts: run.drafts.map((d) => ({ version: d.version, createdAt: d.createdAt, note: d.note, status: d.result.status, files: d.files, issues: d.result.issues.map(view), changes: d.result.changes, suggestions: d.suggestions, attempts: d.result.attempts, dismissed: d.dismissed ?? { changes: [], issues: [] }, editedFile: d.editedFile ?? null })),
    reviewerNotes: run.reviewerNotes, stages: run.stageLog, final: run.final, save: run.save, rating: run.rating, error: run.error,
  };
}
