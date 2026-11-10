import { toRunView } from '@/lib/api-types';
import { approveRun } from '@/lib/approval';
import { json, loadRun, route } from '@/lib/http';
import { proposeAfterApproval } from '@/learning/loop';

export const maxDuration = 60;

/** POST /api/runs/:id/approve — mark final and save to GitHub. Calling it again retries a failed save. */
export const POST = route('token', async (ctx) => {
  const run = await approveRun(await loadRun(ctx), ctx);
  await proposeAfterApproval(run, ctx);
  return json(toRunView(run));
});
