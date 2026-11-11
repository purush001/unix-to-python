import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunView, StatusView, TraceView } from '@/lib/api-types';
import { mockGitState } from '@/providers/github/mock';
import { mockDb } from '@/providers/storage/mock';
import type { SkillRule } from '@/pipeline/types';
import { freshDb } from '../helpers';

const TOKEN = 'unit-test-access-token-0001';
type Handler = (req: Request, ctx?: { params?: Promise<Record<string, string>> }) => Promise<Response>;
async function cold(p: string, method: 'GET' | 'POST'): Promise<Handler> {
  vi.resetModules();
  return ((await import(p)) as Record<string, Handler>)[method];
}
const req = (url: string, body?: unknown) => new Request(`http://test.local${url}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const call = async (route: string, id: string, body?: unknown) => (await cold(`@/app/api/runs/[id]/${route}/route`, 'POST'))(req(`/api/runs/${id}/${route}`, body ?? {}), params(id));

const SQL = `SET SERVEROUTPUT ON
BEGIN
  FOR r IN (SELECT PROCESS_INSTANCE FROM PS_NW_TMP_WORK) LOOP
    DELETE FROM PS_NW_TMP_WORK WHERE PROCESS_INSTANCE = r.PROCESS_INSTANCE;
    COMMIT;
  END LOOP;
END;
/
`;
const SHELL = '#!/bin/ksh\nset -e\necho "start"\nscp /data/out/pay.lst nwpayxfer@paylocity-vendor.net:/in/\nexit 0\n';

async function convert(source: string): Promise<RunView> {
  const r = await (await cold('@/app/api/convert/route', 'POST'))(req('/api/convert', { source }));
  expect(r.status).toBe(200);
  return (await r.json()) as RunView;
}

beforeEach(() => {
  freshDb();
  process.env.APP_ACCESS_TOKEN = TOKEN;
  delete process.env.MOCK_GITHUB_FAILURES;
});

describe('editing the target by hand', () => {
  it('saves the edit as a new draft version, re-runs the code checks, and says the review did not run', async () => {
    const run = await convert(SQL);
    const v1 = run.drafts[0];
    const edited = v1.files[0].content.replace("DELETE FROM PS_NW_TMP_WORK WHERE", "DELETE /* reviewed by hand */ FROM PS_NW_TMP_WORK WHERE");
    const r = await call('edit', run.id, { file: 'target.sql', content: edited, note: 'added a marker comment' });
    expect(r.status).toBe(200);
    const after = (await r.json()) as RunView;
    expect(after.state).toBe('draft_ready');
    expect(after.drafts).toHaveLength(2);
    expect(after.drafts[0].files[0].content).toBe(v1.files[0].content); // the earlier version is kept
    const v2 = after.drafts[1];
    expect(v2.files[0].content).toBe(edited);
    expect(v2.editedFile).toBe('target.sql');
    expect(v2.note).toBe('Edited by the reviewer: target.sql. added a marker comment');
    expect(v2.issues.map((i) => i.code)).toContain('DRAFT_EDITED_BY_REVIEWER');
    expect(v2.changes.at(-1)).toMatchObject({ ruleId: 'reviewer-edit', risk: 'medium', reason: 'added a marker comment' });
    expect(v2.issues.map((i) => i.code)).not.toContain('CHANGE_RULE_UNKNOWN');
    // the edit is in the trace, and no model was called for it
    const t = (await (await (await cold('@/app/api/runs/[id]/trace/route', 'GET'))(req(`/api/runs/${run.id}/trace`), params(run.id))).json()) as TraceView;
    expect(t.spans.filter((s) => s.name === 'stage.edit')).toHaveLength(1);
    expect(t.totals.llmCalls).toBe(2);
  });

  it('a hand edit goes through the same guardrails: a broken script is an error, a pasted secret and host are stripped', async () => {
    const run = await convert(SQL);
    const base = run.drafts[0].files[0].content;
    let r = await call('edit', run.id, { file: 'target.sql', content: base.replace('END LOOP;', '') });
    let v = ((await r.json()) as RunView).drafts.at(-1)!;
    expect(v.status).toBe('failed');
    expect(v.issues.map((i) => i.code)).toContain('SQL_PARSE_ERROR');

    r = await call('edit', run.id, { file: 'target.sql', content: `-- connect scott/Tr0ub4dor&3@db01.corp-internal.example.org, ask margaret.okafor@northwind-hr.com\n${base}` });
    const body = await r.text();
    expect(r.status).toBe(200);
    for (const leaked of ['corp-internal', 'okafor', 'northwind']) expect(body).not.toContain(leaked);
    v = (JSON.parse(body) as RunView).drafts.at(-1)!;
    expect(v.issues.some((i) => i.code === 'SANITIZE_LEAK_DETECTED' || i.code === 'SECRET_IN_OUTPUT')).toBe(true);
  });

  it('refuses an unchanged or empty edit, an unknown file, the shared runtime, and a run that is already approved', async () => {
    const run = await convert(SHELL);
    const d = run.drafts[0];
    expect(d.files.map((f) => f.name)).toContain('script_runtime.py');
    expect((await call('edit', run.id, { file: 'target.py', content: d.files[0].content })).status).toBe(400);
    expect((await call('edit', run.id, { file: 'target.py', content: '   ' })).status).toBe(400);
    expect((await call('edit', run.id, { file: 'nope.py', content: 'x = 1\n' })).status).toBe(400);
    const rt = await call('edit', run.id, { file: 'script_runtime.py', content: 'x = 1\n' });
    expect(rt.status).toBe(422);
    expect(((await rt.json()) as { error: { code: string } }).error.code).toBe('FILE_NOT_EDITABLE');
    await call('approve', run.id);
    expect((await call('edit', run.id, { file: 'target.py', content: d.files[0].content + '\n# x\n' })).status).toBe(409);
  });

  it('an edited Python script that drops run_main fails the checks', async () => {
    const run = await convert(SHELL);
    const py = run.drafts[0].files[0].content;
    const r = await call('edit', run.id, { file: 'target.py', content: py.replace('return run_main(job, parse_args, argv)', 'return job(None, parse_args(argv))') });
    const v = ((await r.json()) as RunView).drafts.at(-1)!;
    expect(v.status).toBe('failed');
    expect(v.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['PY_STRUCTURE', 'PY_NO_ERROR_EMAIL']));
  });
});

describe('removing items from the change list and the feedback panel', () => {
  it('removes and restores a change and a warning; the record keeps them and the saved report marks them', async () => {
    const run = await convert(SQL);
    const d = run.drafts[0];
    expect(d.dismissed).toEqual({ changes: [], issues: [] });
    const warning = d.issues.findIndex((i) => i.severity === 'warning');
    expect(warning).toBeGreaterThanOrEqual(0);
    let r = await call('dismiss', run.id, { version: 1, kind: 'change', index: 0, dismissed: true });
    expect(r.status).toBe(200);
    r = await call('dismiss', run.id, { version: 1, kind: 'issue', index: warning, dismissed: true });
    let after = ((await r.json()) as RunView).drafts[0];
    expect(after.dismissed).toEqual({ changes: [0], issues: [warning] });
    // nothing was deleted
    expect(after.changes).toEqual(d.changes);
    expect(after.issues).toEqual(d.issues);
    expect(after.status).toBe(d.status);

    r = await call('dismiss', run.id, { version: 1, kind: 'change', index: 0, dismissed: false });
    after = ((await r.json()) as RunView).drafts[0];
    expect(after.dismissed).toEqual({ changes: [], issues: [warning] });

    await call('dismiss', run.id, { version: 1, kind: 'change', index: 0, dismissed: true });
    await call('approve', run.id);
    const report = mockGitState().commits.at(-1)!.files.find((f) => f.path.endsWith('report.md'))!.content;
    expect(report).toContain('_(removed from view by the reviewer)_');
    expect(report).toContain('**Removed from view by the reviewer.**');
    expect(report).toContain(d.issues[warning].code);
    // an approved run is a fixed record
    expect((await call('dismiss', run.id, { version: 1, kind: 'change', index: 0, dismissed: false })).status).toBe(409);
  });

  it('an error can never be removed, and bad indexes and versions are rejected', async () => {
    const run = await convert(SQL);
    const broken = await call('edit', run.id, { file: 'target.sql', content: run.drafts[0].files[0].content.replace('END LOOP;', '') });
    const v2 = ((await broken.json()) as RunView).drafts[1];
    const error = v2.issues.findIndex((i) => i.severity === 'error');
    const r = await call('dismiss', run.id, { version: 2, kind: 'issue', index: error, dismissed: true });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('ISSUE_NOT_DISMISSIBLE');
    expect((await call('dismiss', run.id, { version: 2, kind: 'issue', index: 999, dismissed: true })).status).toBe(400);
    expect((await call('dismiss', run.id, { version: 9, kind: 'change', index: 0, dismissed: true })).status).toBe(404);
    expect((await call('dismiss', run.id, { version: 2, kind: 'other', index: 0, dismissed: true })).status).toBe(400);
  });
});

describe('"Ask for a fix" on the built-in converter', () => {
  const codesOf = (r: RunView) => r.drafts.at(-1)!.issues.map((i) => i.code);
  const revise = async (id: string, note: string) => (await (await call('revise', id, { note })).json()) as RunView;

  it('adds SPOOL when asked to fix SQL_OUTPUT_NOT_SPOOLED, and records the change', async () => {
    const run = await convert(SQL);
    expect(codesOf(run)).toContain('SQL_OUTPUT_NOT_SPOOLED');
    const after = await revise(run.id, 'Fix SQL_OUTPUT_NOT_SPOOLED: The script does not SPOOL its output.');
    const d = after.drafts.at(-1)!;
    expect(codesOf(after)).not.toContain('SQL_OUTPUT_NOT_SPOOLED');
    expect(d.files[0].content).toMatch(/^SPOOL script_output\.log$/m);
    expect(d.files[0].content.trimEnd().endsWith('SPOOL OFF')).toBe(true);
    expect(d.changes.some((c) => c.ruleId === 'reviewer-note' && c.summary.startsWith('SPOOL script_output.log'))).toBe(true);
    expect(d.status).not.toBe('failed');
  });

  it('moves a COMMIT out of the loop when asked to fix SQL_COMMIT_IN_LOOP, and marks it high risk', async () => {
    const run = await convert(SQL);
    expect(codesOf(run)).toContain('SQL_COMMIT_IN_LOOP');
    const after = await revise(run.id, 'Fix SQL_COMMIT_IN_LOOP at line 5: COMMIT inside a loop was kept as in the source.');
    const d = after.drafts.at(-1)!;
    expect(codesOf(after)).not.toContain('SQL_COMMIT_IN_LOOP');
    expect(d.files[0].content).toMatch(/END LOOP;\n\s*COMMIT;/);
    expect(d.files[0].content.match(/\bCOMMIT;/g)).toHaveLength(1);
    expect(d.changes.find((c) => c.summary.startsWith('COMMIT moved'))).toMatchObject({ risk: 'high' });
    expect(d.status).not.toBe('failed');
  });

  it('leaves a conditional COMMIT alone: that needs a person', async () => {
    const conditional = SQL.replace('    COMMIT;', '    IF MOD(r.PROCESS_INSTANCE, 100) = 0 THEN\n      COMMIT;\n    END IF;');
    const run = await convert(conditional);
    const after = await revise(run.id, 'Fix SQL_COMMIT_IN_LOOP: COMMIT inside a loop was kept as in the source.');
    expect(codesOf(after)).toContain('SQL_COMMIT_IN_LOOP');
    expect(after.drafts.at(-1)!.files[0].content).toContain('IF MOD(r.PROCESS_INSTANCE, 100) = 0 THEN\n      COMMIT;');
  });

  it('does nothing for a code it has no rule for, and without being asked', async () => {
    const run = await convert(SQL);
    const first = run.drafts[0].files[0].content;
    const after = await revise(run.id, 'Fix SQL_ERROR_SWALLOWED: please re-raise. Also tidy the layout.');
    expect(after.drafts.at(-1)!.files[0].content).toBe(first);
  });
});

describe('deleting a run from Recent runs', () => {
  const del = async (id: string, token = TOKEN) =>
    (await cold('@/app/api/runs/[id]/route', 'DELETE' as 'GET'))(new Request(`http://test.local/api/runs/${id}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } }), params(id));
  const status = async () => (await (await (await cold('@/app/api/status/route', 'GET'))(req('/api/status'))).json()) as StatusView;

  it('removes the run and its feedback from storage; other runs stay', async () => {
    const a = await convert(SQL);
    const b = await convert(SHELL);
    await call('feedback', a.id, { rating: 2, comment: 'not what I wanted' });
    expect((await status()).runs.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    expect(mockDb().feedback.filter((f) => f.runId === a.id)).toHaveLength(1);

    const r = await del(a.id);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ id: a.id, deleted: true, savedCopyKept: false });
    expect((await status()).runs.map((x) => x.id)).toEqual([b.id]);
    expect(mockDb().feedback.filter((f) => f.runId === a.id)).toHaveLength(0);
    expect((await (await cold('@/app/api/runs/[id]/route', 'GET'))(req(`/api/runs/${a.id}`), params(a.id))).status).toBe(404);
    // deleting it again, or a run that never existed, is a 404
    expect((await del(a.id)).status).toBe(404);
    expect((await del('run_missing')).status).toBe(404);
    // the deletion is logged by run id and state, never with content
    const log = mockDb().logs.find((l) => l.msg === 'run deleted');
    expect(log).toMatchObject({ runId: a.id, data: { state: 'draft_ready', savedToGitHub: false } });
  });

  it('needs the access token, keeps the GitHub copy of a saved run, and refuses a run that is still converting', async () => {
    const run = await convert(SQL);
    expect((await del(run.id, 'wrong-token')).status).toBe(401);
    await call('approve', run.id);
    const commits = mockGitState().commits.length;
    const r = await del(run.id);
    expect(await r.json()).toMatchObject({ deleted: true, savedCopyKept: true });
    expect(mockGitState().commits).toHaveLength(commits); // nothing was removed from GitHub

    const busy = await convert(SHELL);
    const stored = mockDb().runs.get(busy.id)!;
    mockDb().runs.set(busy.id, { ...stored, state: 'drafting', updatedAt: new Date().toISOString() });
    const refused = await del(busy.id);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('RUN_BUSY');
    // an abandoned "drafting" run can be deleted once it is clearly no longer running
    mockDb().runs.set(busy.id, { ...stored, state: 'drafting', updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() });
    expect((await del(busy.id)).status).toBe(200);
  });
});

describe('deleting a learned rule', () => {
  const rule = (id: string, over: Partial<SkillRule> = {}): SkillRule => ({ id, version: 1, platform: 'plsql', trigger: ['cursor-loop'], guidance: 'Prefer one set-based statement.', example: { before: 'x', after: 'y' }, sourceRunId: null, evalWitness: null, status: 'promoted', indexed: true, mirrored: true, ...over });
  const del = async (id: string, token = TOKEN) =>
    (await cold('@/app/api/rules/[id]/route', 'DELETE' as 'GET'))(new Request(`http://test.local/api/rules/${id}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } }), params(id));
  const status = async () => (await (await (await cold('@/app/api/status/route', 'GET'))(req('/api/status'))).json()) as StatusView;

  it('removes the rule from storage so it is no longer listed or used; other rules stay', async () => {
    mockDb().rules.set('learned-plsql_aaa', rule('learned-plsql_aaa'));
    mockDb().rules.set('learned-plsql_bbb', rule('learned-plsql_bbb', { status: 'rejected', mirrored: false }));
    expect((await status()).rules.map((r) => r.id)).toEqual(['learned-plsql_aaa', 'learned-plsql_bbb']);

    const r = await del('learned-plsql_aaa');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ id: 'learned-plsql_aaa', deleted: true, mirroredCopyKept: true });
    expect((await status()).rules.map((x) => x.id)).toEqual(['learned-plsql_bbb']);
    // a conversion after the delete does not retrieve it
    const run = await convert(SQL);
    const t = (await (await (await cold('@/app/api/runs/[id]/trace/route', 'GET'))(req(`/api/runs/${run.id}/trace`), params(run.id))).json()) as TraceView;
    expect(JSON.stringify(t.spans.find((s) => s.name === 'retrieval')?.attrs)).not.toContain('learned-plsql_aaa');
    expect(mockDb().logs.find((l) => l.msg === 'rule deleted')?.data).toMatchObject({ ruleId: 'learned-plsql_aaa', status: 'promoted' });

    expect(await (await del('learned-plsql_bbb')).json()).toMatchObject({ deleted: true, mirroredCopyKept: false });
    expect((await status()).rules).toEqual([]);
  });

  it('refuses to delete when the rule cannot be taken out of the index first, and keeps the rule', async () => {
    const { deleteRule } = await import('@/learning/loop');
    const { createLogger } = await import('@/lib/logger');
    const { createProviders } = await import('@/providers');
    const { createMockStorage } = await import('@/providers/storage/mock');
    mockDb().rules.set('learned-plsql_ddd', rule('learned-plsql_ddd'));
    const providers = createProviders({ storage: createMockStorage() });
    const broken = { ...providers, memory: { ...providers.memory, remove: async () => Promise.reject(new Error('index down')) } };
    expect(await deleteRule('learned-plsql_ddd', { providers: broken, log: createLogger() })).toBe('index-unavailable');
    expect(mockDb().rules.has('learned-plsql_ddd')).toBe(true);
    // a rule that was never indexed (a candidate) does not need the index at all
    mockDb().rules.set('learned-plsql_eee', rule('learned-plsql_eee', { status: 'candidate' }));
    expect(await deleteRule('learned-plsql_eee', { providers: broken, log: createLogger() })).toMatchObject({ mirroredCopyKept: true });
    expect(mockDb().rules.has('learned-plsql_eee')).toBe(false);
  });

  it('needs the access token, and answers 404 for an unknown rule or a built-in rule', async () => {
    mockDb().rules.set('learned-plsql_ccc', rule('learned-plsql_ccc'));
    expect((await del('learned-plsql_ccc', 'wrong-token')).status).toBe(401);
    expect(mockDb().rules.has('learned-plsql_ccc')).toBe(true);
    expect((await del('learned-nope')).status).toBe(404);
    expect((await del('base-plsql-error-capture')).status).toBe(404);
  });
});
