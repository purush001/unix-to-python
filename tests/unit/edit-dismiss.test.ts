import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunView, TraceView } from '@/lib/api-types';
import { mockGitState } from '@/providers/github/mock';
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
