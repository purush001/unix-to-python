import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderError } from '@/lib/errors';
import { createVoyageEmbeddings } from '@/providers/embeddings/real';
import { createRealGitHub } from '@/providers/github/real';
import { createAnthropicLlm } from '@/providers/llm/real';

/** The real providers are exercised against stubbed HTTP. No live service is called. */
const sse = (events: [string, unknown][]) => new Response(events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const message = (text: string, stop = 'end_turn') =>
  sse([
    ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 11, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 7 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);
const task = { kind: 'generate' as const, platform: 'plsql' as const, payload: {} };

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-unit-test-key-DDDD4444';
  process.env.GITHUB_TOKEN = 'ghp_unitTestToken0000000000000000000000';
  process.env.GITHUB_REPO = 'acme/conversions';
  process.env.VOYAGE_API_KEY = 'pa-unit-test-voyage-key';
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'GITHUB_REPO', 'VOYAGE_API_KEY', 'LLM_MODEL']) delete process.env[k];
});

describe('Anthropic provider', () => {
  it('sends the configured model with adaptive thinking and fallbacks, and returns text and usage', async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: unknown, init?: { body?: string }) => {
      bodies.push(JSON.parse(init?.body ?? '{}'));
      return message('<converted>\nSELECT 1 FROM DUAL;\n</converted>');
    }));
    const res = await createAnthropicLlm().complete({ system: 'SYS', user: 'USER', timeoutMs: 5000, task });
    expect(res.text).toContain('SELECT 1 FROM DUAL;');
    expect(res.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
    expect(bodies[0]).toMatchObject({ model: 'claude-opus-5-5', stream: true, system: 'SYS', thinking: { type: 'adaptive' }, fallbacks: 'default', messages: [{ role: 'user', content: 'USER' }] });
  });

  it('maps a cut-off reply and an empty reply to transient errors, and a refusal to a non-transient one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => message('partial', 'max_tokens')));
    const cut = await createAnthropicLlm().complete({ system: 's', user: 'u', timeoutMs: 5000, task }).catch((e) => e);
    expect(cut).toBeInstanceOf(ProviderError);
    expect([cut.failure, cut.transient]).toEqual(['malformed', true]);
    vi.stubGlobal('fetch', vi.fn(async () => message('   ')));
    const empty = await createAnthropicLlm().complete({ system: 's', user: 'u', timeoutMs: 5000, task }).catch((e) => e);
    expect([empty.failure, empty.transient]).toEqual(['empty', true]);
    vi.stubGlobal('fetch', vi.fn(async () => message('', 'refusal')));
    const refused = await createAnthropicLlm().complete({ system: 's', user: 'u', timeoutMs: 5000, task }).catch((e) => e);
    expect([refused.status, refused.transient]).toEqual([422, false]);
  });

  it('keeps HTTP status codes and never puts the key in the error', async () => {
    for (const status of [429, 500, 529]) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ type: 'error', error: { type: 'x', message: 'key sk-ant-unit-test-key-DDDD4444 rejected' } }), { status, headers: { 'content-type': 'application/json' } })));
      const err = await createAnthropicLlm().complete({ system: 's', user: 'u', timeoutMs: 5000, task }).catch((e) => e);
      expect(err.status).toBe(status);
      expect(err.transient).toBe(status >= 500);
      expect(String(err.message)).not.toContain('DDDD4444');
    }
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const net = await createAnthropicLlm().complete({ system: 's', user: 'u', timeoutMs: 5000, task }).catch((e) => e);
    expect([net.failure, net.transient]).toEqual(['network', true]);
  });
});

describe('GitHub provider', () => {
  const api = (routes: Record<string, { status: number; json: unknown }>, calls: { method: string; path: string; body: unknown; auth: string }[]) =>
    vi.fn(async (url: string, init: { method: string; body?: string; headers: Record<string, string> }) => {
      const path = url.replace('https://api.github.com/repos/acme/conversions', '');
      calls.push({ method: init.method, path, body: init.body ? JSON.parse(init.body) : null, auth: init.headers.authorization });
      const r = routes[`${init.method} ${path}`] ?? { status: 500, json: {} };
      return new Response(JSON.stringify(r.json), { status: r.status });
    });
  const files = [{ path: 'conversions/2026-11-10-run_x/target.sql', content: 'SELECT 1 FROM DUAL;\n' }, { path: 'conversions/2026-11-10-run_x/witness.json', content: '{}\n' }];

  it('creates the data branch with one commit when it does not exist', async () => {
    const calls: { method: string; path: string; body: unknown; auth: string }[] = [];
    vi.stubGlobal('fetch', api({
      'GET /git/ref/heads/conversions-data': { status: 404, json: {} },
      'POST /git/trees': { status: 201, json: { sha: 'tree1' } },
      'POST /git/commits': { status: 201, json: { sha: 'commit1' } },
      'POST /git/refs': { status: 201, json: {} },
    }, calls));
    const res = await createRealGitHub().commitFiles({ branch: 'conversions-data', message: 'Add conversion', files });
    expect(res).toEqual({ sha: 'commit1', url: 'https://github.com/acme/conversions/commit/commit1', branch: 'conversions-data' });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /git/ref/heads/conversions-data', 'POST /git/trees', 'POST /git/commits', 'POST /git/refs']);
    expect(calls[1].body).toEqual({ tree: files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })) });
    expect(calls[2].body).toEqual({ message: 'Add conversion', tree: 'tree1', parents: [] });
    expect(calls[3].body).toEqual({ ref: 'refs/heads/conversions-data', sha: 'commit1' });
    expect(calls.every((c) => c.auth === 'Bearer ghp_unitTestToken0000000000000000000000')).toBe(true);
  });

  it('adds a commit on top of an existing branch without forcing', async () => {
    const calls: { method: string; path: string; body: unknown; auth: string }[] = [];
    vi.stubGlobal('fetch', api({
      'GET /git/ref/heads/conversions-data': { status: 200, json: { object: { sha: 'parent1' } } },
      'GET /git/commits/parent1': { status: 200, json: { tree: { sha: 'basetree' } } },
      'POST /git/trees': { status: 201, json: { sha: 'tree2' } },
      'POST /git/commits': { status: 201, json: { sha: 'commit2' } },
      'PATCH /git/refs/heads/conversions-data': { status: 200, json: {} },
    }, calls));
    const res = await createRealGitHub().commitFiles({ branch: 'conversions-data', message: 'm', files });
    expect(res.sha).toBe('commit2');
    expect((calls[2].body as { base_tree: string }).base_tree).toBe('basetree');
    expect(calls[3].body).toEqual({ message: 'm', tree: 'tree2', parents: ['parent1'] });
    expect(calls[4].body).toEqual({ sha: 'commit2', force: false });
  });

  it('reports a failed call with its status and without the token', async () => {
    vi.stubGlobal('fetch', api({ 'GET /git/ref/heads/conversions-data': { status: 403, json: { message: 'Resource not accessible' } } }, []));
    const err = await createRealGitHub().commitFiles({ branch: 'conversions-data', message: 'm', files }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.status).toBe(403);
    expect(String(err.message)).not.toContain('ghp_');
  });
});

describe('Voyage embeddings provider', () => {
  it('posts documents and queries with the right input type and returns vectors in input order', async () => {
    const seen: { url: string; body: { input: string[]; model: string; input_type: string }; auth: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body: string; headers: Record<string, string> }) => {
      seen.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization });
      return new Response(JSON.stringify({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] }), { status: 200 });
    }));
    const e = createVoyageEmbeddings();
    expect(e.model).toBe('voyage-code-4');
    expect(await e.embed(['a', 'b'], 'document')).toEqual([[1, 0], [0, 1]]);
    await e.embed(['q'], 'query');
    expect(seen[0]).toEqual({ url: 'https://ai.mongodb.com/v1/embeddings', body: { input: ['a', 'b'], model: 'voyage-code-4', input_type: 'document' }, auth: 'Bearer pa-unit-test-voyage-key' });
    expect(seen[1].body.input_type).toBe('query');
  });
});
