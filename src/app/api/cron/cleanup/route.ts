import { getConfigInt } from '@/config/env';
import { json, route } from '@/lib/http';

export const maxDuration = 60;

/** GET /api/cron/cleanup — Vercel Cron. Enforces the log retention limit. */
export const GET = route('cron', async (ctx) => {
  const cutoff = new Date(Date.now() - getConfigInt('LOG_RETENTION_DAYS') * 86400000).toISOString();
  const deleted = await ctx.providers.storage.deleteLogsBefore(cutoff);
  ctx.log.info('log cleanup', { deleted, retentionDays: getConfigInt('LOG_RETENTION_DAYS') });
  return json({ ok: true, deleted });
});
