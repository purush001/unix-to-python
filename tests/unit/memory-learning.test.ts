import { beforeEach, describe, expect, it } from 'vitest';
import { BASE_RULES } from '@skills/base';
import { createLogger } from '@/lib/logger';
import { compare, disableRule, learnTick, proposeAfterApproval, verifyCandidate } from '@/learning/loop';
import { reindexMemory, retrieveGuidance, syncPendingMemory, topExamples, topRules } from '@/learning/memory';
import { approveRun } from '@/lib/approval';
import { Codes } from '@/pipeline/issue-codes';
import type { ConversionExample, SkillRule } from '@/pipeline/types';
import { createMockEmbeddings } from '@/providers/embeddings/mock';
import { mockGitState } from '@/providers/github/mock';
import { createMockMemory } from '@/providers/memory/mock';
import type { VectorMemory } from '@/providers/types';
import type { FixtureResult } from '@evals/suite';
import { convert, freshDb, MOCK, reply, scriptedLlm, SIMPLE_PLSQL, testProviders } from '../helpers';

const rule = (id: string, over: Partial<SkillRule> = {}): SkillRule => ({
  id, version: 1, platform: 'plsql', trigger: ['cursor-loop'], guidance: `Guidance for ${id}: replace cursor loops with set based SQL`, example: { before: 'FOR r IN c LOOP', after: 'UPDATE t SET x = 1' },
  sourceRunId: null, evalWitness: null, status: 'promoted', indexed: false, ...over,
});
const example = (runId: string, platform: ConversionExample['platform'] = 'plsql'): ConversionExample => ({ runId, platform, tags: ['cursor-loop'], before: 'FOR r IN c LOOP UPDATE PS_JOB', after: 'UPDATE PS_JOB SET', createdAt: '2026-01-01T00:00:00Z', indexed: false });
const failing = (): VectorMemory => ({
  name: 'down',
  upsert: async () => { throw new Error('down'); }, query: async () => { throw new Error('down'); }, remove: async () => { throw new Error('down'); },
  reset: async () => { throw new Error('down'); }, count: async () => { throw new Error('down'); }, ping: async () => { throw new Error('down'); },
});

beforeEach(freshDb);

describe('memory retrieval', () => {
  it('filters by platform and by promoted status, and caps the matches', async () => {
    const p = testProviders();
    for (let i = 0; i < 8; i++) await p.storage.upsertRule(rule(`learned-plsql-${i}`));
    await p.storage.upsertRule(rule('learned-shell-1', { platform: 'shell-python' }));
    await p.storage.upsertRule(rule('cand-1', { status: 'candidate' }));
    await p.storage.upsertRule(rule('rej-1', { status: 'rejected' }));
    await p.storage.upsertRule(rule('off-1', { status: 'disabled' }));
    for (let i = 0; i < 4; i++) await p.storage.upsertExample(example(`run_${i}`));
    await p.storage.upsertExample(example('run_shell', 'shell-python'));

    const r = await retrieveGuidance(p, { platform: 'plsql', tags: ['cursor-loop'], excerpt: 'FOR r IN c LOOP UPDATE PS_JOB SET x = 1; END LOOP;' });
    expect(r.warning).toBeNull();
    expect(r.rules).toHaveLength(topRules());
    expect(r.examples).toHaveLength(topExamples());
    expect(r.rules).not.toContain('learned-shell-1');
    for (const id of ['cand-1', 'rej-1', 'off-1']) expect(r.rules).not.toContain(id);
    const shellOnly = BASE_RULES.filter((b) => b.platform === 'shell-python').map((b) => b.id);
    expect(r.rules.some((id) => shellOnly.includes(id))).toBe(false);
    expect(r.examples).not.toContain('example-run_shell');
    expect(r.guidance.filter((g) => g.kind === 'rule')).toHaveLength(topRules());
  });

  it('falls back to the base rules and warns when the memory is unavailable', async () => {
    const p = testProviders({ memory: failing() });
    const r = await retrieveGuidance(p, { platform: 'plsql', tags: ['cursor-loop', 'commit-in-loop'], excerpt: 'LOOP' });
    expect(r.warning?.code).toBe(Codes.MEMORY_UNAVAILABLE);
    expect(r.rules.length).toBeGreaterThan(0);
    expect(r.rules.every((id) => id.startsWith('base-plsql'))).toBe(true);
    // and a whole conversion still completes, carrying the warning
    const run = await convert(SIMPLE_PLSQL, testProviders({ memory: failing() }));
    expect(run.state).toBe('draft_ready');
    expect(run.drafts[0].result.warnings.map((w) => w.code)).toContain(Codes.MEMORY_UNAVAILABLE);
  });

  it('rebuilds the index from storage', async () => {
    const memory = createMockMemory();
    const p = testProviders({ memory, embeddings: createMockEmbeddings() });
    delete (memory as { ephemeral?: boolean }).ephemeral; // behave like a persistent index
    await p.storage.upsertRule(rule('learned-plsql-a'));
    await p.storage.upsertRule(rule('cand-x', { status: 'candidate' }));
    await p.storage.upsertExample(example('run_a'));
    await memory.upsert('skill_rules', [{ id: 'stale', document: 'old', embedding: [1], metadata: { platform: 'plsql', status: 'promoted', refId: 'stale', version: 1, tags: 'x', embeddingModel: 'm' } }]);

    const res = await reindexMemory(p);
    expect(res).toEqual({ rules: BASE_RULES.length + 1, examples: 1 });
    expect(await memory.count('skill_rules')).toBe(BASE_RULES.length + 1); // stale entry and the candidate are gone
    expect(await memory.count('conversion_examples')).toBe(1);
    expect((await p.storage.getRule('learned-plsql-a'))?.indexed).toBe(true);
    const hit = await retrieveGuidance(p, { platform: 'plsql', tags: ['cursor-loop'], excerpt: 'cursor loops set based SQL' });
    expect(hit.rules).toContain('learned-plsql-a');
  });

  it('retries failed index writes later and never indexes candidates', async () => {
    const memory = createMockMemory();
    const p = testProviders({ memory });
    await p.storage.upsertRule(rule('learned-plsql-b'));
    await p.storage.upsertRule(rule('cand-y', { status: 'candidate', indexed: false }));
    await p.storage.upsertExample(example('run_b'));
    const r = await syncPendingMemory(p, 10);
    expect(r).toEqual({ synced: 2, failed: 0 });
    expect(await memory.count('skill_rules')).toBe(1);
    expect((await p.storage.listRules({ unindexedOnly: true })).map((x) => x.id)).toEqual(['cand-y']);
  });
});

const result = (id: string, over: Partial<FixtureResult> = {}): FixtureResult => ({ id, hash: 'h', kind: 'golden', status: 'ok', errorCodes: [], warningCodes: [], attempts: 0, transientRetries: 0, leaks: 0, secrets: 0, seedHits: [], syntaxOk: true, dualHits: 0, failedChecks: [], pass: true, outputs: [], ...over });

describe('learning loop', () => {
  it('compares eval results: regressions, improvements and leaks', () => {
    const base = [result('a', { warningCodes: ['SQL_COMMIT_IN_LOOP'] }), result('b')];
    expect(compare(base, [result('a'), result('b')])).toEqual({ regressions: [], improvements: ['a: fewer warnings (1 → 0)'], leaks: 0 });
    expect(compare(base, [result('a', { warningCodes: ['SQL_COMMIT_IN_LOOP'] }), result('b', { pass: false, failedChecks: ['x'] })]).regressions).toHaveLength(1);
    expect(compare(base, [result('a'), result('b', { leaks: 1 })]).leaks).toBe(1);
  });

  it('stores the example and proposes a candidate after an approved, revised conversion', async () => {
    const p = testProviders();
    const deps = { providers: p, log: createLogger() };
    const run = await convert(SIMPLE_PLSQL, p, { persist: true });
    const { beginRevision, continueRun } = await import('@/agents/orchestrator');
    beginRevision(run, 'Keep the spool file name as it is');
    await continueRun(run, deps, { budgetMs: 60000 });
    const approved = await approveRun(run, deps);
    expect(approved.state).toBe('saved');
    await proposeAfterApproval(approved, deps);
    const examples = await p.storage.listExamples();
    expect(examples).toHaveLength(1);
    expect(examples[0].indexed).toBe(true);
    const cands = await p.storage.listRules({ status: 'candidate' });
    expect(cands).toHaveLength(1);
    expect(cands[0].sourceRunId).toBe(run.id);
    expect(cands[0].guidance).toContain('Keep the spool file name');
    // proposing twice does nothing
    await proposeAfterApproval(approved, deps);
    expect(await p.storage.listRules({ status: 'candidate' })).toHaveLength(1);
  });

  it('rejects a candidate when no eval metric improves, and records the witness', async () => {
    const p = testProviders(); // the mock provider ignores guidance, so nothing can improve
    const deps = { providers: p, log: createLogger() };
    await p.storage.upsertRule(rule('cand-noop', { status: 'candidate', indexed: true }));
    const tick = await learnTick(deps, { batch: 2, deadline: Date.now() + 120000 });
    expect(tick).toEqual({ verified: 1, pending: 0 });
    const r = (await p.storage.getRule('cand-noop'))!;
    expect(r.status).toBe('rejected');
    expect(r.rejectReason).toBe('No eval metric improved.');
    const w = r.evalWitness as { state: string; fixtureHashes: Record<string, string>; report: { baseline: { fixtures: number }; regressions: string[] } };
    expect(w.state).toBe('complete');
    expect(Object.keys(w.fixtureHashes).length).toBe(w.report.baseline.fixtures);
    expect(mockGitState().commits).toHaveLength(0);
  }, 120000);

  it('promotes a candidate that improves a metric without regressions: storage, index and data-branch mirror', async () => {
    // This provider only produces the fully valid draft when the candidate rule is in its guidance.
    const good = 'SET SERVEROUTPUT ON\nSPOOL hcm_upd_supervisor.log\n';
    const llm = scriptedLlm((req) => {
      if (req.task.kind === 'review' || req.task.platform !== 'plsql') return MOCK;
      const src = String(req.task.payload.source ?? '');
      if (!src.includes('PS_NW_TMP_WORK')) return MOCK;
      if (req.task.kind === 'repair' || req.user.includes('cand-good')) return MOCK; // mock output has the capture handler
      return reply(src.startsWith('SET') ? src : good + src); // without the rule: no error capture → one repair attempt
    });
    const memory = createMockMemory();
    const p = testProviders({ llm, memory });
    const deps = { providers: p, log: createLogger() };
    await p.storage.upsertRule(rule('cand-good', { status: 'candidate', indexed: true, trigger: [] }));
    const r = await verifyCandidate((await p.storage.getRule('cand-good'))!, deps, Date.now() + 120000);
    expect(r.status).toBe('promoted');
    const w = r.evalWitness as { report: { improvements: string[]; regressions: string[] } };
    expect(w.report.regressions).toEqual([]);
    expect(w.report.improvements.join(' ')).toMatch(/adv-hidden-instructions: fewer repair attempts/);
    const stored = (await p.storage.getRule('cand-good'))!;
    expect(stored.status).toBe('promoted');
    expect(stored.indexed).toBe(true);
    expect(stored.mirrored).toBe(true);
    const commit = mockGitState().commits.at(-1)!;
    expect(commit.branch).toBe('conversions-data');
    expect(commit.files[0].path).toBe('skills/learned/plsql/cand-good.json');
    // a human can disable it: it leaves the index and stops guiding generation
    delete (memory as { ephemeral?: boolean }).ephemeral;
    const before = await memory.count('skill_rules');
    await disableRule('cand-good', deps);
    expect((await p.storage.getRule('cand-good'))!.status).toBe('disabled');
    expect(await memory.count('skill_rules')).toBe(before - 1);
  }, 120000);

  it('verifies in batches and continues in a later invocation', async () => {
    const p = testProviders();
    const deps = { providers: p, log: createLogger() };
    await p.storage.upsertRule(rule('cand-slow', { status: 'candidate', indexed: true }));
    const first = await verifyCandidate((await p.storage.getRule('cand-slow'))!, deps, Date.now() - 1); // no time at all
    expect(first.status).toBe('candidate');
    expect((first.evalWitness as { next: number }).next).toBe(0);
    const second = await verifyCandidate((await p.storage.getRule('cand-slow'))!, deps, Date.now() + 120000);
    expect(second.status).toBe('rejected');
  }, 120000);
});

