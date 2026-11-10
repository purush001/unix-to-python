import { z } from 'zod';
import { setDismissed } from '@/agents/orchestrator';
import { toRunView } from '@/lib/api-types';
import { json, loadRun, readJson, route } from '@/lib/http';

const Body = z.object({ version: z.number().int().positive(), kind: z.enum(['change', 'issue']), index: z.number().int().min(0), dismissed: z.boolean() });

/**
 * POST /api/runs/:id/dismiss — remove a change-list item or a warning from view, or restore it.
 * Nothing is deleted from the record, and an error can never be removed.
 */
export const POST = route('token', async (ctx) => {
  const body = await readJson(ctx.req, Body);
  return json(toRunView(await setDismissed(await loadRun(ctx), body.version, body.kind, body.index, body.dismissed, ctx)));
});
