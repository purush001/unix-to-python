import { z } from 'zod';
import { beginRevision, continueRun } from '@/agents/orchestrator';
import { getConfigInt } from '@/config/env';
import { loadRun, readJson, route, runResponse } from '@/lib/http';

export const maxDuration = 300;

const Body = z.object({ note: z.string().trim().min(1).max(2000) });

/** POST /api/runs/:id/revise — rerun the pipeline with the reviewer's note and return a new draft. */
export const POST = route(
  'token',
  async (ctx) => {
    const body = await readJson(ctx.req, Body);
    const run = await loadRun(ctx);
    beginRevision(run, body.note);
    await ctx.providers.storage.saveRun(run);
    return runResponse(ctx.req, (onProgress) => continueRun(run, ctx, { budgetMs: getConfigInt('REQUEST_BUDGET_MS'), onProgress }));
  },
  { limited: true },
);
