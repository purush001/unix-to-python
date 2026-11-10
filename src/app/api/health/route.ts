import { json, route } from '@/lib/http';
import { providerModes } from '@/providers';

/** GET /api/health — which providers are mock or real. No configuration values are revealed. */
export const GET = route('none', async () => json({ ok: true, providers: providerModes() }));
