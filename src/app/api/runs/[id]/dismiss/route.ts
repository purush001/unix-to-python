import { z } from 'zod';
import { setDismissed } from '@/agents/orchestrator';
import { toRunView } from '@/lib/api-types';
import { json, loadRun, readJson, route } from '@/lib/http';

const Body = z
  .object({
    version: z.number().int().positive(),
    kind: z.enum(['change', 'issue']),
    /** One item, or several at once (the same entry reported on several lines). */
    index: z.number().int().min(0).optional(),
    indexes: z.array(z.number().int().min(0)).min(1).max(500).optional(),
    dismissed: z.boolean(),
  })
  .refine((b) => b.index !== undefined || b.indexes !== undefined, { message: 'Give index or indexes.' });

/**
 * POST /api/runs/:id/dismiss — delete change-list items or feedback entries from the lists, or
 * restore them. Nothing is deleted from the record, and the draft's status does not change.
 */
export const POST = route('token', async (ctx) => {
  const body = await readJson(ctx.req, Body);
  const indexes = body.indexes ?? [body.index as number];
  return json(toRunView(await setDismissed(await loadRun(ctx), body.version, body.kind, indexes, body.dismissed, ctx)));
});
