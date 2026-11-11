import { AppError } from '@/lib/errors';
import { json, route } from '@/lib/http';
import { deleteRule } from '@/learning/loop';

/**
 * DELETE /api/rules/:id — a human deletes a learned rule for good. It is removed from the
 * index and from storage; a copy already mirrored to GitHub is kept. Built-in rules are code
 * and cannot be deleted here.
 */
export const DELETE = route('token', async (ctx) => {
  const r = await deleteRule(ctx.id, ctx);
  if (r === null) throw new AppError('NOT_FOUND', 'Rule not found.', 404);
  if (r === 'index-unavailable') throw new AppError('MEMORY_UNAVAILABLE', 'The rule index could not be reached, so the rule was not deleted. Disable it for now and delete it later.', 503);
  return json({ id: r.rule.id, deleted: true, mirroredCopyKept: r.mirroredCopyKept });
});
