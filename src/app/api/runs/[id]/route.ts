import { toRunView } from '@/lib/api-types';
import { json, loadRun, route } from '@/lib/http';

/** GET /api/runs/:id — the stored state, so the page recovers after a reload or a cut-off request. */
export const GET = route('token', async (ctx) => json(toRunView(await loadRun(ctx))));
