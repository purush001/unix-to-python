import { toRunView } from '@/lib/api-types';
import { AppError } from '@/lib/errors';
import { json, loadRun, route } from '@/lib/http';

/** GET /api/runs/:id — the stored state, so the page recovers after a reload or a cut-off request. */
export const GET = route('token', async (ctx) => json(toRunView(await loadRun(ctx))));

/** A run that was written this recently in state "drafting" may still be converting in another request. */
const BUSY_WINDOW_MS = 5 * 60 * 1000;

/**
 * DELETE /api/runs/:id — removes a run and its feedback from storage. It cannot be undone.
 * A conversion already saved to GitHub stays there, and log lines are kept until the
 * retention limit; only the stored run is deleted.
 */
export const DELETE = route('token', async (ctx) => {
  const run = await loadRun(ctx);
  if (run.state === 'drafting' && Date.now() - Date.parse(run.updatedAt) < BUSY_WINDOW_MS) {
    throw new AppError('RUN_BUSY', 'This run is still being converted. Wait for it to finish, then delete it.', 409, run.id);
  }
  await ctx.providers.storage.deleteRun(run.id);
  ctx.log.info('run deleted', { state: run.state, scriptType: run.scriptType, drafts: run.drafts.length, savedToGitHub: run.save?.status === 'saved' });
  return json({ id: run.id, deleted: true, savedCopyKept: run.save?.status === 'saved' });
});
