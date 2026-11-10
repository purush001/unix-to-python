import { z } from 'zod';
import { applyEdit } from '@/agents/orchestrator';
import { toRunView } from '@/lib/api-types';
import { json, loadRun, readJson, route } from '@/lib/http';

const Body = z.object({ file: z.string().min(1).max(80), content: z.string(), note: z.string().max(2000).optional() });

/**
 * POST /api/runs/:id/edit — a person edits the latest draft. The edit passes the output
 * guardrails and the code validators and becomes a new draft version. No model is called.
 */
export const POST = route(
  'token',
  async (ctx) => {
    const body = await readJson(ctx.req, Body);
    return json(toRunView(await applyEdit(await loadRun(ctx), body.file, body.content, body.note ?? '', ctx)));
  },
  { limited: true },
);
