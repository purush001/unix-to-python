import type { StatusView } from '@/lib/api-types';
import { json, route } from '@/lib/http';
import { computeMetrics } from '@/lib/metrics';
import { providerModes } from '@/providers';

/** GET /api/status — recent runs, metrics and the learned rules with their witnesses. */
export const GET = route('token', async (ctx) => {
  const s = ctx.providers.storage;
  const [runs, logs, feedback, rules, pendingRules, pendingExamples] = await Promise.all([s.listRuns(200), s.listLogs(2000), s.listFeedback(500), s.listRules(), s.listRules({ unindexedOnly: true }), s.listExamples({ unindexedOnly: true })]);
  const view: StatusView = {
    providers: providerModes(),
    runs: runs.slice(0, 25).map((r) => {
      const d = r.drafts[r.drafts.length - 1];
      return { id: r.id, state: r.state, scriptType: r.scriptType, platform: r.platform, createdAt: r.createdAt, status: d?.result.status ?? null, attempts: d?.result.attempts ?? 0, rating: r.rating?.rating ?? null };
    }),
    metrics: computeMetrics(runs, logs, feedback, rules, pendingRules.filter((r) => r.status !== 'candidate').length + pendingExamples.length),
    rules: rules.map((r) => ({ id: r.id, platform: r.platform, status: r.status, version: r.version, trigger: r.trigger, guidance: r.guidance, sourceRunId: r.sourceRunId, rejectReason: r.rejectReason ?? null, witness: (r.evalWitness as { report?: unknown } | null)?.report ?? null })),
  };
  return json(view);
});
