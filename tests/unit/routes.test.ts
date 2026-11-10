import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunView, StatusView } from '@/lib/api-types';
import { mockDb } from '@/providers/storage/mock';
import { freshDb } from '../helpers';

const TOKEN = 'unit-test-access-token';
const SOURCE = readFileSync('evals/fixtures/hcm-employee-update.sql', 'utf8');

type Handler = (req: Request, ctx?: { params?: Promise<Record<string, string>> }) => Promise<Response>;

/** Loads a route module from scratch: no module state survives from earlier calls (a cold start). */
async function cold(path: string, method: 'GET' | 'POST'): Promise<Handler> {
  vi.resetModules();
  const mod = (await import(path)) as Record<string, Handler>;
  return mod[method];
}
function req(url: string, init: { method?: string; body?: unknown; token?: string | null; accept?: string } = {}): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.token !== null) headers.authorization = `Bearer ${init.token ?? TOKEN}`;
  if (init.accept) headers.accept = init.accept;
  return new Request(`http://test.local${url}`, { method: init.method ?? (init.body === undefined ? 'GET' : 'POST'), headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  freshDb();
  process.env.APP_ACCESS_TOKEN = TOKEN;
  process.env.CRON_SECRET = 'unit-test-cron-secret-0001';
  for (const k of ['LLM_PROVIDER', 'ANTHROPIC_API_KEY', 'MOCK_GITHUB_FAILURES', 'RATE_LIMIT_PER_MINUTE', 'MAX_INPUT_BYTES']) delete process.env[k];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('API routes as isolated functions', () => {
  it('runs the whole flow with a cold start per endpoint, using only what is in storage', async () => {
    const convert = await cold('@/app/api/convert/route', 'POST');
    let res = await convert(req('/api/convert', { body: { source: SOURCE, options: { generateConfig: false } } }));
    expect(res.status).toBe(200);
    let run = (await res.json()) as RunView;
    expect(run.state).toBe('draft_ready');
    expect(run.drafts[0].files[0].name).toBe('target.sql');
    const id = run.id;

    res = await (await cold('@/app/api/runs/[id]/route', 'GET'))(req(`/api/runs/${id}`), params(id));
    expect(((await res.json()) as RunView).drafts).toHaveLength(1);

    res = await (await cold('@/app/api/runs/[id]/revise/route', 'POST'))(req(`/api/runs/${id}/revise`, { body: { note: 'Keep the commit inside the loop' } }), params(id));
    run = (await res.json()) as RunView;
    expect(res.status).toBe(200);
    expect(run.drafts).toHaveLength(2);
    expect(run.drafts[1].note).toBe('Keep the commit inside the loop');

    res = await (await cold('@/app/api/runs/[id]/approve/route', 'POST'))(req(`/api/runs/${id}/approve`, { method: 'POST' }), params(id));
    run = (await res.json()) as RunView;
    expect(run.state).toBe('saved');
    expect(run.save?.commit?.branch).toBe('conversions-data');
    expect(run.save?.commit?.path).toMatch(new RegExp(`^conversions/\\d{4}-\\d{2}-\\d{2}-${id}$`));

    res = await (await cold('@/app/api/runs/[id]/feedback/route', 'POST'))(req(`/api/runs/${id}/feedback`, { body: { rating: 2, comment: 'The loop should have been rewritten' } }), params(id));
    expect(((await res.json()) as RunView).rating?.rating).toBe(2);

    res = await (await cold('@/app/api/status/route', 'GET'))(req('/api/status'));
    const status = (await res.json()) as StatusView;
    expect(status.runs[0].id).toBe(id);
    expect(status.metrics.runsByState.saved).toBe(1);
    expect(status.metrics.ratingDistribution['2']).toBe(1);
    expect(status.rules.filter((r) => r.status === 'candidate').length).toBeGreaterThanOrEqual(1);
    expect(status.providers.llm).toBe('mock');

    const ruleId = status.rules[0].id;
    res = await (await cold('@/app/api/rules/[id]/disable/route', 'POST'))(req(`/api/rules/${ruleId}/disable`, { method: 'POST' }), params(ruleId));
    expect(await res.json()).toEqual({ id: ruleId, status: 'disabled' });

    res = await (await cold('@/app/api/health/route', 'GET'))(req('/api/health', { token: null }));
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    // logs were written to storage, never script content
    expect(mockDb().logs.length).toBeGreaterThan(5);
  });

  it('streams stage progress as NDJSON and ends with the result', async () => {
    const res = await (await cold('@/app/api/convert/route', 'POST'))(req('/api/convert', { body: { source: SOURCE }, accept: 'application/x-ndjson' }));
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    const events = (await res.text()).trim().split('\n').map((l) => JSON.parse(l) as { type: string; stage?: string; status?: string });
    expect(events.filter((e) => e.type === 'stage' && e.status === 'done').map((e) => e.stage)).toEqual(['intake', 'generate', 'validate', 'review', 'results']);
    expect(events.at(-1)?.type).toBe('result');
  });

  it('returns the documented status codes for bad requests', async () => {
    const convert = await cold('@/app/api/convert/route', 'POST');
    expect((await convert(req('/api/convert', { body: { source: SOURCE }, token: null }))).status).toBe(401);
    expect((await convert(req('/api/convert', { body: { source: SOURCE }, token: 'wrong' }))).status).toBe(401);
    expect((await convert(req('/api/convert', { body: { nope: 1 } }))).status).toBe(400);
    const empty = await convert(req('/api/convert', { body: { source: '  ' } }));
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: { code: 'INPUT_EMPTY', message: 'The input is empty.', status: 400 } });
    const prose = await convert(req('/api/convert', { body: { source: 'Dear team, the payroll run moves to Thursday.' } }));
    expect(prose.status).toBe(422);
    expect(((await prose.json()) as { error: { code: string } }).error.code).toBe('INPUT_UNSUPPORTED_TYPE');
    process.env.MAX_INPUT_BYTES = '200';
    const big = await convert(req('/api/convert', { body: { source: 'SELECT 1 FROM DUAL;\n'.repeat(40) } }));
    expect(big.status).toBe(413);
    delete process.env.MAX_INPUT_BYTES;
    expect((await (await cold('@/app/api/runs/[id]/route', 'GET'))(req('/api/runs/run_missing'), params('run_missing'))).status).toBe(404);
    expect((await (await cold('@/app/api/cron/learn/route', 'GET'))(req('/api/cron/learn', { token: null }))).status).toBe(401);
    expect((await (await cold('@/app/api/cron/cleanup/route', 'GET'))(req('/api/cron/cleanup', { token: TOKEN }))).status).toBe(401);
    const ok = await (await cold('@/app/api/cron/cleanup/route', 'GET'))(req('/api/cron/cleanup', { token: 'unit-test-cron-secret-0001' }));
    expect(ok.status).toBe(200);
  });

  it('rate-limits through shared storage', async () => {
    process.env.RATE_LIMIT_PER_MINUTE = '2';
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await (await cold('@/app/api/convert/route', 'POST'))(req('/api/convert', { body: { source: 'SELECT 1 FROM DUAL;' } }))).status);
    expect(statuses).toEqual([200, 200, 429, 429]); // the counter lives in storage, so it survives cold starts
  });

  it('keeps an approved run when the GitHub save fails, and saves on retry', async () => {
    process.env.MOCK_GITHUB_FAILURES = '1';
    let res = await (await cold('@/app/api/convert/route', 'POST'))(req('/api/convert', { body: { source: SOURCE } }));
    const id = ((await res.json()) as RunView).id;
    res = await (await cold('@/app/api/runs/[id]/approve/route', 'POST'))(req(`/api/runs/${id}/approve`, { method: 'POST' }), params(id));
    let run = (await res.json()) as RunView;
    expect(run.state).toBe('approved');
    expect(run.save).toEqual({ status: 'failed', error: 'Mock GitHub: simulated save failure' });
    expect(run.final?.version).toBe(1); // the final output is not lost
    res = await (await cold('@/app/api/runs/[id]/approve/route', 'POST'))(req(`/api/runs/${id}/approve`, { method: 'POST' }), params(id));
    run = (await res.json()) as RunView;
    expect(run.state).toBe('saved');
    expect(run.save?.commit?.sha).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('provider errors and secret handling', () => {
  const upstream = (status: number, seen: string[]) =>
    vi.fn(async (_url: unknown, init?: { headers?: unknown }) => {
      const h = new Headers(init?.headers as HeadersInit);
      // the SDK sends the key as x-api-key or as a bearer token depending on its shape
      seen.push(h.get('x-api-key') ?? (h.get('authorization') ?? '').replace(/^Bearer /, ''));
      return new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }), { status, headers: { 'content-type': 'application/json' } });
    });

  it('returns the provider status as is when nothing could be drafted (429), and 503 after transient retries', async () => {
    process.env.LLM_PROVIDER = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-unit-test-key-AAAA1111';
    process.env.RETRY_BASE_MS = '0';
    const seen: string[] = [];
    vi.stubGlobal('fetch', upstream(429, seen));
    let res = await (await cold('@/app/api/convert/route', 'POST'))(req('/api/convert', { body: { source: SOURCE } }));
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string; status: number; message: string } };
    expect(body.error.code).toBe('PROVIDER_ERROR');
    expect(body.error.status).toBe(429);
    expect(seen).toHaveLength(1);

    seen.length = 0;
    vi.stubGlobal('fetch', upstream(503, seen));
    res = await (await cold('@/app/api/convert/route', 'POST'))(req('/api/convert', { body: { source: SOURCE }, accept: 'application/x-ndjson' }));
    expect(res.status).toBe(503); // even when a stream was requested: no draft, so the real status
    expect(seen).toHaveLength(3); // one call and two transient retries
    delete process.env.RETRY_BASE_MS;
  });

  it('uses the key of the current request and keeps no copy afterwards', async () => {
    process.env.LLM_PROVIDER = 'anthropic';
    const seen: string[] = [];
    vi.stubGlobal('fetch', upstream(429, seen));
    const convert = await cold('@/app/api/convert/route', 'POST'); // ONE module instance for all calls: a warm function
    process.env.ANTHROPIC_API_KEY = 'sk-ant-unit-test-key-AAAA1111';
    await convert(req('/api/convert', { body: { source: SOURCE } }));
    process.env.ANTHROPIC_API_KEY = 'sk-ant-unit-test-key-BBBB2222';
    await convert(req('/api/convert', { body: { source: SOURCE } }));
    expect(seen).toEqual(['sk-ant-unit-test-key-AAAA1111', 'sk-ant-unit-test-key-BBBB2222']);

    // with the key gone from the environment, nothing in module state can supply it
    delete process.env.ANTHROPIC_API_KEY;
    const res = await convert(req('/api/convert', { body: { source: SOURCE } }));
    expect(res.status).toBe(500);
    expect(seen).toHaveLength(2);
    const text = JSON.stringify(await res.json()) + JSON.stringify(mockDb().logs) + JSON.stringify([...mockDb().runs.values()]);
    expect(text).not.toContain('AAAA1111');
    expect(text).not.toContain('BBBB2222');
  });

  it('redacts secrets from error text', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-unit-test-key-CCCC3333';
    const { redact } = await import('@/lib/errors');
    expect(redact('failed with key sk-ant-unit-test-key-CCCC3333 and postgres://u:hunter2@db/x and Bearer abcdefgh12345678')).toBe('failed with key [REDACTED] and postgres://u:[REDACTED]@db/x and Bearer [REDACTED]');
    delete process.env.ANTHROPIC_API_KEY;
  });
});
