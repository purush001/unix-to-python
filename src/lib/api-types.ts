import type { Issue } from '@/pipeline/issue-codes';
import { ISSUE_CATALOGUE } from '@/pipeline/issue-codes';
import type { Change, OutputFile, Platform, ProgressEvent, RunRecord, RunState, SanitizeCounts, ScriptType, StageName, Suggestion } from '@/pipeline/types';
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
  };
  rules: { id: string; platform: Platform; status: string; version: number; trigger: string[]; guidance: string; sourceRunId: string | null; rejectReason: string | null; witness: unknown }[];
}

const view = (i: Issue): IssueView => ({ ...i, explanation: ISSUE_CATALOGUE[i.code].explanation, nextStep: ISSUE_CATALOGUE[i.code].nextStep });

export function toRunView(run: RunRecord): RunView {
  return {
    id: run.id, state: run.state, resumable: run.state === 'drafting', scriptType: run.scriptType, platform: run.platform, createdAt: run.createdAt, updatedAt: run.updatedAt,
    sanitizedSource: run.sanitizedSource,
    sanitization: { counts: run.sanitization.counts, summary: countSummary(run.sanitization.counts), warnings: run.sanitization.warnings.map(view), highlightLines: run.sanitization.highlightLines },
    drafts: run.drafts.map((d) => ({ version: d.version, createdAt: d.createdAt, note: d.note, status: d.result.status, files: d.files, issues: d.result.issues.map(view), changes: d.result.changes, suggestions: d.suggestions, attempts: d.result.attempts })),
    reviewerNotes: run.reviewerNotes, stages: run.stageLog, final: run.final, save: run.save, rating: run.rating, error: run.error,
  };
}
