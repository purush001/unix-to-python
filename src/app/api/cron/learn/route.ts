import { getConfigInt } from '@/config/env';
import { json, route } from '@/lib/http';
import { learnTick } from '@/learning/loop';
import { syncPendingMemory } from '@/learning/memory';

export const maxDuration = 300;

/** GET /api/cron/learn — Vercel Cron. Verifies candidate rules in small batches and retries pending index writes. */
export const GET = route('cron', async (ctx) => {
  const deadline = Date.now() + Math.min(getConfigInt('REQUEST_BUDGET_MS'), 240000);
  const learn = await learnTick(ctx, { batch: getConfigInt('CRON_BATCH_SIZE'), deadline });
  const sync = await syncPendingMemory(ctx.providers, 20);
  ctx.log.info('learn tick', { verified: learn.verified, pending: learn.pending, indexSynced: sync.synced, indexFailed: sync.failed });
  return json({ ok: true, ...learn, memory: sync });
});
