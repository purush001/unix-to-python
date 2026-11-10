import { z } from 'zod';
import { continueRun, intake } from '@/agents/orchestrator';
import { getConfigInt } from '@/config/env';
import { readJson, route, runResponse } from '@/lib/http';

export const maxDuration = 300;

const Body = z.object({
  source: z.string(),
  scriptType: z.enum(['auto', 'sql', 'plsql', 'sqlplus', 'shell', 'mixed']).optional(),
  options: z.object({ generateConfig: z.boolean().optional() }).optional(),
});

/** POST /api/convert — sanitize, convert and return the draft. The raw input lives in this request only. */
export const POST = route(
  'token',
  async (ctx) => {
    const body = await readJson(ctx.req, Body);
    const limits = { budgetMs: getConfigInt('REQUEST_BUDGET_MS') };
    return runResponse(ctx.req, async (onProgress) => {
      const run = await intake(body.source, body.scriptType ?? 'auto', { generateConfig: body.options?.generateConfig ?? false }, ctx, { ...limits, onProgress });
      return continueRun(run, ctx, { ...limits, onProgress });
    });
  },
  { limited: true },
);
