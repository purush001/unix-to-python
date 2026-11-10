import { z } from 'zod';
import { toRunView } from '@/lib/api-types';
import { json, loadRun, readJson, route } from '@/lib/http';
import { newId, nowIso } from '@/lib/util';
import { proposeAfterFeedback } from '@/learning/loop';
import { ALL_CODES, type IssueCode } from '@/pipeline/issue-codes';
import type { Feedback } from '@/pipeline/types';
import { sanitize } from '@/sanitizer';

const Body = z
  .object({
    rating: z.number().int().min(1).max(5).optional(),
    comment: z.string().trim().max(2000).optional(),
    errorCode: z.enum(ALL_CODES as [IssueCode, ...IssueCode[]]).optional(),
    line: z.number().int().positive().optional(),
  })
  .refine((b) => b.rating !== undefined || b.comment || b.errorCode, { message: 'Give a rating, a comment or an error code.' });

/** POST /api/runs/:id/feedback — a rating, or a problem report against a warning or line. */
export const POST = route('token', async (ctx) => {
  const body = await readJson(ctx.req, Body);
  const run = await loadRun(ctx);
  const comment = body.comment ? sanitize(body.comment, 'text').text : null;
  const fb: Feedback = { id: newId('fb'), runId: run.id, rating: body.rating ?? null, comment, errorCode: body.errorCode ?? null, line: body.line ?? null, at: nowIso() };
  await ctx.providers.storage.addFeedback(fb);
  if (fb.rating !== null) {
    run.rating = { rating: fb.rating, comment, at: fb.at };
    run.updatedAt = fb.at;
    await ctx.providers.storage.saveRun(run);
  }
  ctx.log.info('feedback received', { rating: fb.rating, errorCode: fb.errorCode, hasComment: !!comment });
  await proposeAfterFeedback(run, fb, ctx);
  return json(toRunView(run));
});
