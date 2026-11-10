import { getConfig, getConfigInt } from '@/config/env';
import type { Logger } from '@/lib/logger';
import { addLlmSpan, spanClock } from '@/lib/trace';
import { sha256 } from '@/lib/util';
import type { RunRecord } from '@/pipeline/types';
import type { Providers } from '@/providers/types';
import { assertClean } from '@/sanitizer';
import { judgeDraft, judgePromptVersion } from './judge';

/** Deterministic sample: the same run is always in or out for a given percentage. */
export function sampled(runId: string, percent: number): boolean {
  return Number.parseInt(sha256(runId).slice(0, 8), 16) % 100 < percent;
}

const JUDGEABLE: RunRecord['state'][] = ['draft_ready', 'approved', 'saved'];

/**
 * S15. Live judges: score a sample of production runs asynchronously. Called from the cron
 * job only, never from a user request, so it can never delay the user. The verdict is
 * attached to the run as a score and the judge call is added to the run's trace.
 */
export async function liveJudgeTick(deps: { providers: Providers; log: Logger }, opts: { deadline: number }): Promise<{ judged: number; failed: number; skipped: number }> {
  const percent = getConfigInt('LIVE_JUDGE_SAMPLE_PERCENT');
  const batch = getConfigInt('LIVE_JUDGE_BATCH');
  let judged = 0;
  let failed = 0;
  let skipped = 0;
  if (percent <= 0) return { judged, failed, skipped };
  for (const run of await deps.providers.storage.listRuns(200)) {
    if (judged + failed >= batch || Date.now() >= opts.deadline) break;
    const d = run.drafts[run.drafts.length - 1];
    if (!d || !JUDGEABLE.includes(run.state) || run.judge?.draftVersion === d.version) continue;
    if (!sampled(run.id, percent)) {
      skipped++;
      continue;
    }
    const log = deps.log.child({ runId: run.id, stage: 'judge' });
    const c = spanClock();
    const base = { role: 'judge', operation: 'judge', promptVersion: judgePromptVersion(), requestModel: getConfig('JUDGE_MODEL'), maxTokens: getConfigInt('LLM_JUDGE_MAX_TOKENS'), attempt: 1, parentId: null, unitId: null, startedAt: c.startedAt };
    try {
      // only sanitized text may leave the server; scan again before the call
      assertClean(run.sanitizedSource, 'judge:source', run.platform === 'plsql' ? 'sql' : 'shell');
      const r = await judgeDraft(deps.providers.llm, { platform: run.platform, source: run.sanitizedSource, draft: d.files[0].content, changes: d.result.changes, draftVersion: d.version });
      addLlmSpan(run, { ...base, ms: Date.now() - c.t0 }, r.response);
      run.judge = r.score;
      await deps.providers.storage.saveRun(run);
      log.info('live judge', { score: r.score.score, failedCriteria: r.score.criteria.filter((x) => x.verdict === 'no').map((x) => x.id), unknownCriteria: r.score.criteria.filter((x) => x.verdict === 'unknown').length, model: r.score.model, promptVersion: r.score.promptVersion, draftVersion: d.version });
      judged++;
    } catch (e) {
      addLlmSpan(run, { ...base, ms: Date.now() - c.t0 }, e);
      await deps.providers.storage.saveRun(run).catch(() => {});
      log.warn('live judge failed', { error: e instanceof Error ? e.name : 'unknown' });
      failed++;
    }
  }
  return { judged, failed, skipped };
}
