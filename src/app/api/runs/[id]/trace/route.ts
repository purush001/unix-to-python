import { toTraceView } from '@/lib/api-types';
import { json, loadRun, route } from '@/lib/http';

/** GET /api/runs/:id/trace — the run's spans with tokens, cost and latency, and its scores. No script text. */
export const GET = route('token', async (ctx) => json(toTraceView(await loadRun(ctx))));
