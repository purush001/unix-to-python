import { continueRun } from '@/agents/orchestrator';
import { getConfigInt } from '@/config/env';
import { AppError } from '@/lib/errors';
import { loadRun, route, runResponse } from '@/lib/http';

export const maxDuration = 300;

/** POST /api/runs/:id/resume — continue a run that was cut off, from the last completed stage. */
export const POST = route(
  'token',
  async (ctx) => {
    const run = await loadRun(ctx);
    if (run.state !== 'drafting' && run.state !== 'sanitized' && run.state !== 'changes_requested') throw new AppError('INVALID_STATE', `A run in state "${run.state}" has nothing to resume.`, 409, run.id);
    return runResponse(ctx.req, (onProgress) => continueRun(run, ctx, { budgetMs: getConfigInt('REQUEST_BUDGET_MS'), onProgress }));
  },
  { limited: true },
);
