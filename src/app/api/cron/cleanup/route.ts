import { getConfigInt } from '@/config/env';
import { alertMail, evaluateAlerts } from '@/lib/alerts';
import { json, route } from '@/lib/http';
import { computeMetrics } from '@/lib/metrics';

export const maxDuration = 60;

/** GET /api/cron/cleanup — Vercel Cron. Enforces the log retention limit, then evaluates the alerts and mails their owner. */
export const GET = route('cron', async (ctx) => {
  const cutoff = new Date(Date.now() - getConfigInt('LOG_RETENTION_DAYS') * 86400000).toISOString();
  const deleted = await ctx.providers.storage.deleteLogsBefore(cutoff);
  ctx.log.info('log cleanup', { deleted, retentionDays: getConfigInt('LOG_RETENTION_DAYS') });
  // daily alert check: mail the owner of every alert that is firing
  const s = ctx.providers.storage;
  const runs = await s.listRuns(200);
  const logs = await s.listLogs(2000);
  const alerts = evaluateAlerts(computeMetrics(runs, logs, [], [], 0).last24h);
  const firing = alerts.filter((a) => a.firing);
  let notified = false;
  if (firing.length) {
    ctx.log.warn('alerts firing', { alerts: firing.map((a) => a.id) });
    try {
      await ctx.providers.smtp.send({ to: firing[0].owner, ...alertMail(firing) });
      notified = true;
    } catch {
      ctx.log.error('alert notification failed', { alerts: firing.map((a) => a.id) });
    }
  }
  return json({ ok: true, deleted, alerts: firing.map((a) => a.id), notified });
});
