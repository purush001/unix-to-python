import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StatusView, TraceView } from '@/lib/api-types';
import type { RunView } from '@/lib/api-types';
import { evaluateAlerts } from '@/lib/alerts';
import { createLogger } from '@/lib/logger';
import { computeMetrics } from '@/lib/metrics';
import { replayDir } from '@/lib/replay';
import { liveJudgeTick, sampled } from '@/judge/live';
import { mockGitState } from '@/providers/github/mock';
import { mockOutbox } from '@/providers/smtp/mock';
import { mockDb } from '@/providers/storage/mock';
import { convert as runConvert, freshDb, MOCK, scriptedLlm, testProviders } from '../helpers';

const TOKEN = 'unit-test-access-token-0001';
const CRON = 'unit-test-cron-secret-0001';
type Handler = (req: Request, ctx?: { params?: Promise<Record<string, string>> }) => Promise<Response>;
async function cold(p: string, method: 'GET' | 'POST'): Promise<Handler> {
  vi.resetModules();
  return ((await import(p)) as Record<string, Handler>)[method];
}
function req(url: string, init: { method?: string; body?: unknown; token?: string; contentType?: string | null } = {}): Request {
  const headers: Record<string, string> = { authorization: `Bearer ${init.token ?? TOKEN}` };
  if (init.contentType !== null) headers['content-type'] = init.contentType ?? 'application/json';
  return new Request(`http://test.local${url}`, { method: init.method ?? (init.body === undefined ? 'GET' : 'POST'), headers, body: init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : JSON.stringify(init.body) });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

/** A purge script whose loop commits every row: the seeded complaint case of docs/runbooks/complaint.md. */
const COMPLAINT_SOURCE = `SET SERVEROUTPUT ON
SPOOL purge.log
BEGIN
  FOR r IN (SELECT PROCESS_INSTANCE FROM PS_NW_TMP_WORK WHERE RUN_DT < SYSDATE - 30) LOOP
    DELETE FROM PS_NW_TMP_WORK WHERE PROCESS_INSTANCE = r.PROCESS_INSTANCE;
    COMMIT;
  END LOOP;
END;
/
SPOOL OFF
`;

beforeEach(() => {
  freshDb();
  process.env.APP_ACCESS_TOKEN = TOKEN;
  process.env.CRON_SECRET = CRON;
});
afterEach(() => {
  for (const k of ['LIVE_JUDGE_SAMPLE_PERCENT', 'ALERT_MIN_RUNS', 'ALERT_SAVE_FAILURES', 'MOCK_GITHUB_FAILURES', 'ALERT_OWNER']) delete process.env[k];
});

describe('S13 wrong content type on the API', () => {
  it('rejects a body that is not sent as application/json with 415, before reading it', async () => {
    const convert = await cold('@/app/api/convert/route', 'POST');
    for (const contentType of ['text/plain', 'multipart/form-data; boundary=x', null]) {
      const r = await convert(req('/api/convert', { body: 'SELECT 1 FROM DUAL;', contentType }));
      expect(r.status).toBe(415);
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    }
  });
});

describe('S15 trace endpoint, scores, metrics and alerts', () => {
  it('serves the trace of a run with every span, totals, the witness summary and attached scores', async () => {
    let r = await (await cold('@/app/api/convert/route', 'POST'))(req('/api/convert', { body: { source: COMPLAINT_SOURCE } }));
    const id = ((await r.json()) as RunView).id;
    await (await cold('@/app/api/runs/[id]/feedback/route', 'POST'))(req(`/api/runs/${id}/feedback`, { body: { rating: 2, comment: 'commit moved' } }), params(id));
    r = await (await cold('@/app/api/runs/[id]/trace/route', 'GET'))(req(`/api/runs/${id}/trace`), params(id));
    expect(r.status).toBe(200);
    const t = (await r.json()) as TraceView;
    expect(t.traceId).toBe(id);
    expect(t.spans.map((s) => s.kind)).toEqual(expect.arrayContaining(['guardrail', 'retrieval', 'llm', 'stage']));
    expect(t.totals.llmCalls).toBe(2);
    expect(t.totals.costUsd).toBe(0); // the mock model is priced at zero
    expect(t.scores.userRating).toBe(2);
    expect(t.witness?.models).toEqual(['mock']);
    expect(Object.keys(t.witness?.promptVersions ?? {})).toEqual(['sql-agent', 'reviewer']);
    expect(JSON.stringify(t)).not.toContain('PS_NW_TMP_WORK');
    expect((await (await cold('@/app/api/runs/[id]/trace/route', 'GET'))(req('/api/runs/run_missing/trace'), params('run_missing'))).status).toBe(404);
  });

  it('the cron job scores a sample of finished runs and attaches the verdict to the trace', async () => {
    process.env.LIVE_JUDGE_SAMPLE_PERCENT = '100';
    const r = await (await cold('@/app/api/convert/route', 'POST'))(req('/api/convert', { body: { source: COMPLAINT_SOURCE } }));
    const id = ((await r.json()) as RunView).id;
    const cron = await (await cold('@/app/api/cron/learn/route', 'GET'))(req('/api/cron/learn', { token: CRON }));
    expect(((await cron.json()) as { judge: unknown }).judge).toEqual({ judged: 1, failed: 0, skipped: 0 });
    const t = (await (await (await cold('@/app/api/runs/[id]/trace/route', 'GET'))(req(`/api/runs/${id}/trace`), params(id))).json()) as TraceView;
    expect(t.scores.judge).toMatchObject({ score: 1, model: 'mock', draftVersion: 1 });
    expect(t.scores.judge?.criteria.find((c) => c.id === 'F2')).toMatchObject({ verdict: 'yes' });
    expect(t.spans.at(-1)).toMatchObject({ name: 'llm.judge', kind: 'llm' });
    // a judged draft is not judged twice
    const again = await (await cold('@/app/api/cron/learn/route', 'GET'))(req('/api/cron/learn', { token: CRON }));
    expect(((await again.json()) as { judge: { judged: number } }).judge.judged).toBe(0);
  });

  it('sampling is deterministic and respects 0 and 100 percent', async () => {
    expect(sampled('run_a', 0)).toBe(false);
    expect(sampled('run_a', 100)).toBe(true);
    expect(sampled('run_abc', 37)).toBe(sampled('run_abc', 37));
    process.env.LIVE_JUDGE_SAMPLE_PERCENT = '0';
    await runConvert(COMPLAINT_SOURCE, testProviders(), { persist: true });
    expect(await liveJudgeTick({ providers: testProviders(), log: createLogger() }, { deadline: Date.now() + 5000 })).toEqual({ judged: 0, failed: 0, skipped: 0 });
  });

  it('status reports the dashboard metrics and the alerts with thresholds and owners', async () => {
    await (await cold('@/app/api/convert/route', 'POST'))(req('/api/convert', { body: { source: COMPLAINT_SOURCE } }));
    await (await cold('@/app/api/convert/route', 'POST'))(req('/api/convert', { body: { source: 'Dear team, payroll moves to Thursday.' } }));
    const s = (await (await (await cold('@/app/api/status/route', 'GET'))(req('/api/status'))).json()) as StatusView;
    expect(s.metrics).toMatchObject({ volume: 1, successRate: 1, costUsd: 0, unpricedCalls: 0, rateLimited: 0, guardrails: { inputRejected: { INPUT_UNSUPPORTED_TYPE: 1 }, inputBlockRate: 0.5, outputStripped: 0 } });
    expect(Object.keys(s.metrics.llmLatency)).toEqual(['llm.generate', 'llm.review']);
    expect(s.metrics.costByModel.mock.calls).toBe(2);
    expect(s.metrics.topIssueCodes.map((x) => x[0])).toContain('SQL_COMMIT_IN_LOOP');
    expect(s.alerts.map((a) => a.id)).toEqual(['error-rate', 'p95-latency', 'daily-cost', 'guardrail-leak', 'judge-score', 'save-failures']);
    expect(s.alerts.every((a) => a.owner === 'ops@script.com' && !a.firing && typeof a.threshold === 'number')).toBe(true);
  });

  it('alerts fire on a leak, on error rate above the threshold, and on cost; and stay quiet with too few runs', () => {
    const w = { runs: 10, failedRuns: 5, p95GenerateMs: 1000, costUsd: 99, unpricedCalls: 0, guardrailLeaks: 1, judgeMeanScore: 0.5, judgedRuns: 4, saveFailures: 0 };
    expect(evaluateAlerts(w).filter((a) => a.firing).map((a) => a.id)).toEqual(['error-rate', 'daily-cost', 'guardrail-leak', 'judge-score']);
    expect(evaluateAlerts({ ...w, runs: 2, failedRuns: 2, costUsd: 0, guardrailLeaks: 0, judgeMeanScore: null }).filter((a) => a.firing)).toEqual([]);
  });

  it('a model-invented secret is stripped, counted as a guardrail hit and raises the leak alert', async () => {
    const llm = scriptedLlm(async (reqq, i) => {
      if (i !== 0) return MOCK;
      const mock = await testProviders().llm.complete(reqq);
      return mock.text.replace('BEGIN', "-- connect scott/Tr0ub4dor&3 to db01.corp-internal.example.org\nBEGIN");
    });
    const run = await runConvert(COMPLAINT_SOURCE, testProviders({ llm }), { persist: true, maxRepairAttempts: 0 });
    expect(JSON.stringify(run.drafts)).not.toContain('corp-internal');
    expect((run.trace ?? []).find((s) => s.name === 'guardrail.output.scrub')).toMatchObject({ status: 'error', attrs: { 'app.guardrail.action': 'stripped' } });
    const m = computeMetrics([run], [], [], [], 0);
    expect(m.guardrails.outputStripped).toBe(1);
    expect(evaluateAlerts(m.last24h).find((a) => a.id === 'guardrail-leak')?.firing).toBe(true);
  });

  it('the daily cron mails the alert owner when an alert is firing', async () => {
    process.env.MOCK_GITHUB_FAILURES = '1';
    process.env.ALERT_OWNER = 'ops@script.com';
    const r = await (await cold('@/app/api/convert/route', 'POST'))(req('/api/convert', { body: { source: COMPLAINT_SOURCE } }));
    const id = ((await r.json()) as RunView).id;
    await (await cold('@/app/api/runs/[id]/approve/route', 'POST'))(req(`/api/runs/${id}/approve`, { method: 'POST' }), params(id));
    const before = mockOutbox().length;
    const c = await (await cold('@/app/api/cron/cleanup/route', 'GET'))(req('/api/cron/cleanup', { token: CRON }));
    expect(await c.json()).toMatchObject({ alerts: ['save-failures'], notified: true });
    expect(mockOutbox().slice(before).map((m) => m.subject)).toEqual(['Script Modernizer: 1 alert(s) firing']);
  });
});

describe('S16 the complaint runbook on a seeded case', () => {
  it('finds the cause from the trace, reproduces it offline and classifies it', async () => {
    // Seeded complaint: "my purge job used to commit every row; the converted one never commits".
    // The model dropped the COMMIT inside the loop on its first draft.
    const llm = scriptedLlm(async (r, i) => {
      if (r.task.kind !== 'generate' || i !== 0) return MOCK;
      const mock = await testProviders().llm.complete(r);
      return mock.text.replace(/\n\s*COMMIT;\n/, '\n');
    });
    // production: no repair attempts were left, so the faulty draft reached the reviewer
    const run = await runConvert(COMPLAINT_SOURCE, testProviders({ llm }), { persist: true, maxRepairAttempts: 0 });

    // step 1-2: the run ID opens the trace: guardrail summary, router decision, retrieved IDs, prompt version, model
    const spans = run.trace ?? [];
    expect(spans[0]).toMatchObject({ name: 'guardrail.input', attrs: { 'app.router.decision': 'sqlplus' } });
    expect(spans.find((s) => s.name === 'retrieval')?.attrs['app.retrieved.rule_ids']).toContain('base-plsql-cursor-loop');
    const gen = spans.find((s) => s.name === 'llm.generate')!;
    expect(gen.attrs['app.prompt.version']).toMatch(/^[0-9a-f]{12}$/);
    expect(gen.attrs['gen_ai.response.model']).toBe('scripted');

    // step 3: walk the stages: the reviewer caught it, and no repair attempt was left
    const d = run.drafts[0];
    expect(d.result.witness.stageCodes['sql-1']).toEqual([{ validate: [] }, { review: ['REVIEW_TXN_BOUNDARY_CHANGED'] }]);
    expect(d.result.status).toBe('failed');
    expect(d.result.attempts).toBe(0);

    // step 4: replay offline from the stored sanitized input and compare with the witness
    const dir = mkdtempSync(path.join(tmpdir(), 'complaint-'));
    writeFileSync(path.join(dir, 'source.sanitized.sql'), run.sanitizedSource);
    for (const f of d.files) writeFileSync(path.join(dir, f.name), f.content);
    writeFileSync(path.join(dir, 'witness.json'), JSON.stringify(d.result.witness));
    const replay = await replayDir(dir, testProviders());

    // step 5: classify. Same input, same prompt, same validators; a different model gives a clean result.
    expect(replay.identical).toBe(false);
    expect(replay.differences.some((x) => x.startsWith('input'))).toBe(false);
    expect(replay.differences.some((x) => x.startsWith('prompt'))).toBe(false);
    expect(replay.differences.some((x) => x.startsWith('validator'))).toBe(false);
    expect(replay.differences.some((x) => x.startsWith('model: answered by [mock, scripted] then, [mock] now'))).toBe(true);
    // the faulty draft lost the commit-in-loop warning along with the COMMIT; the replay has it back
    expect([replay.then.finalCodes.includes('SQL_COMMIT_IN_LOOP'), replay.now.finalCodes.includes('SQL_COMMIT_IN_LOOP')]).toEqual([false, true]);
    expect(replay.now.stageCodes['sql-1']).toEqual([{ validate: [] }, { review: [] }]);
    // cause: model. The guardrail that should have stopped it (review, then repair) worked; the run had 0 repair attempts.
  });

  it('an unchanged conversion replays identically', async () => {
    const run = await runConvert(COMPLAINT_SOURCE, testProviders(), { persist: true });
    const d = run.drafts[0];
    const dir = mkdtempSync(path.join(tmpdir(), 'replay-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'source.sanitized.sql'), run.sanitizedSource);
    for (const f of d.files) writeFileSync(path.join(dir, f.name), f.content);
    writeFileSync(path.join(dir, 'witness.json'), JSON.stringify(d.result.witness));
    const r = await replayDir(dir, testProviders());
    expect(r).toMatchObject({ identical: true, differences: [] });
    expect(mockDb().runs.size).toBe(1); // the replay stored nothing
    expect(mockGitState().commits).toHaveLength(0);
  });
});
