import { AppError } from '@/lib/errors';
import { json, route } from '@/lib/http';
import { disableRule } from '@/learning/loop';

/** POST /api/rules/:id/disable — a human switches a learned rule off. */
export const POST = route('token', async (ctx) => {
  const rule = await disableRule(ctx.id, ctx);
  if (!rule) throw new AppError('NOT_FOUND', 'Rule not found.', 404);
  ctx.log.info('rule disabled', { ruleId: rule.id });
  return json({ id: rule.id, status: rule.status });
});
