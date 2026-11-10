import { beforeEach, describe, expect, it } from 'vitest';
import { instrumentUnit } from '@/adapters/plsql/blocks';
import { ProviderError } from '@/lib/errors';
import { Codes, errorCodes, issue, sameCodeSet } from '@/pipeline/issue-codes';
import { convert, freshDb, http, MOCK, reply, scriptedLlm, SIMPLE_PLSQL, testProviders } from '../helpers';

const GOOD = () => 'SET SERVEROUTPUT ON\nSPOOL run.log\n' + instrumentUnit("BEGIN\n  UPDATE PS_NW_TMP SET FLAG = 'Y' WHERE PROCESS_INSTANCE = 7;\nEND;\n/", 'anonymous').text + '\nSPOOL OFF\n';
const NO_CAPTURE = SIMPLE_PLSQL; // parses, but has no error capture
const BROKEN = "SET SERVEROUTPUT ON\nSPOOL run.log\nBEGIN\n  UPDATE PS_NW_TMP SET FLAG = 'Y' WHERE PROCESS_INSTANCE = 7;\n/\nSPOOL OFF\n"; // BEGIN never closed

beforeEach(freshDb);

describe('issue codes', () => {
  it('compares codes, never message text', () => {
    const a = [issue(Codes.SQL_PARSE_ERROR, 'looks like SQL_NO_ERROR_CAPTURE but is not', 3), issue(Codes.SQL_COMMIT_IN_LOOP, 'warning only', 4)];
    const b = [issue(Codes.SQL_PARSE_ERROR, 'a completely different message', 9)];
    expect(errorCodes(a)).toEqual([Codes.SQL_PARSE_ERROR]);
    expect(sameCodeSet(errorCodes(a), errorCodes(b))).toBe(true);
    expect(sameCodeSet(errorCodes(a), [Codes.SQL_NO_ERROR_CAPTURE])).toBe(false);
  });
});

describe('pipeline engine', () => {
  it('produces a clean draft with no repair when the first draft validates', async () => {
    const run = await convert(SIMPLE_PLSQL, testProviders({ llm: scriptedLlm((r) => (r.task.kind === 'generate' ? reply(GOOD()) : MOCK)) }));
    const d = run.drafts[0];
    expect(run.state).toBe('draft_ready');
    expect(d.result.status).toBe('ok');
    expect(d.result.attempts).toBe(0);
  });

  it('retries transient failures without consuming a repair attempt', async () => {
    let n = 0;
    const llm = scriptedLlm((r) => {
      if (r.task.kind !== 'generate') return MOCK;
      n++;
      if (n === 1) return http(503);
      if (n === 2) return ''; // empty output is transient too
      return reply(GOOD());
    });
    const run = await convert(SIMPLE_PLSQL, testProviders({ llm }));
    const d = run.drafts[0];
    expect(d.result.attempts).toBe(0);
    expect(d.result.witness.transientRetries).toBe(2);
    expect(d.result.status).toBe('ok');
  });

  it('treats malformed output as transient and gives up after two retries with the provider status', async () => {
    const llm = scriptedLlm(() => 'no sections here');
    await expect(convert(SIMPLE_PLSQL, testProviders({ llm }))).rejects.toBeInstanceOf(ProviderError);
    expect(llm.calls.length).toBe(3); // 1 call + 2 retries
  });

  it('repairs once and stops when the draft becomes valid', async () => {
    const llm = scriptedLlm((r) => (r.task.kind === 'generate' ? reply(NO_CAPTURE) : r.task.kind === 'repair' ? reply(GOOD()) : MOCK));
    const run = await convert(SIMPLE_PLSQL, testProviders({ llm }));
    const d = run.drafts[0];
    expect(d.result.attempts).toBe(1);
    expect(d.result.status).toBe('ok');
    expect(llm.calls.filter((c) => c.task.kind === 'repair')).toHaveLength(1);
    // the repair prompt names the failing code and the adapter's hint for it
    const repair = llm.calls.find((c) => c.task.kind === 'repair')!;
    expect(repair.user).toContain(Codes.SQL_NO_ERROR_CAPTURE);
    expect(repair.user).toContain('How to fix');
  });

  it('stops repairing early when the set of error codes does not change', async () => {
    const llm = scriptedLlm((r) => (r.task.kind === 'review' ? MOCK : reply(NO_CAPTURE)));
    const run = await convert(SIMPLE_PLSQL, testProviders({ llm }), { maxRepairAttempts: 5 });
    const d = run.drafts[0];
    expect(d.result.attempts).toBe(1); // not 5
    expect(d.result.warnings.map((w) => w.code)).toContain(Codes.REPAIR_NO_PROGRESS);
    expect(d.result.status).toBe('failed');
  });

  it('keeps the last usable draft when a repair call fails', async () => {
    let repairs = 0;
    const llm = scriptedLlm((r) => {
      if (r.task.kind === 'generate') return reply(NO_CAPTURE); // usable: it parses
      if (r.task.kind === 'repair') {
        repairs++;
        return repairs === 1 ? reply(BROKEN) : http(500); // attempt 1 does not parse, attempt 2 fails
      }
      return MOCK;
    });
    const run = await convert(SIMPLE_PLSQL, testProviders({ llm }));
    const d = run.drafts[0];
    expect(d.result.warnings.map((w) => w.code)).toContain(Codes.REPAIR_FAILED_KEPT_DRAFT);
    expect(d.result.draft.trim()).toBe(NO_CAPTURE.trim()); // the most recent draft that parsed
    expect(d.result.attempts).toBe(1);
  });

  it('throws the provider error with its real status when nothing could be drafted', async () => {
    const llm = scriptedLlm(() => http(429));
    const err = await convert(SIMPLE_PLSQL, testProviders({ llm })).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.status).toBe(429);
    expect(llm.calls.length).toBe(1); // 429 is not transient: no retry
  });

  it('sends a blocking review finding back for repair', async () => {
    let reviews = 0;
    const llm = scriptedLlm((r) => {
      if (r.task.kind === 'review') {
        reviews++;
        return reviews === 1 ? '<review>[{"code":"REVIEW_SEMANTIC_DRIFT","message":"WHERE clause changed","line":4}]</review>' : '<review>[]</review>';
      }
      return reply(GOOD());
    });
    const run = await convert(SIMPLE_PLSQL, testProviders({ llm }));
    expect(run.drafts[0].result.attempts).toBe(1);
    expect(run.drafts[0].result.status).toBe('ok');
  });

  it('removes anything the model invents that is not a placeholder, and reports it', async () => {
    const leaky = GOOD().replace('SPOOL OFF', "PROMPT mail results to someone@realcorp.com\nSPOOL OFF");
    const llm = scriptedLlm((r) => (r.task.kind === 'review' ? MOCK : reply(leaky)));
    const run = await convert(SIMPLE_PLSQL, testProviders({ llm }));
    const d = run.drafts[0];
    expect(d.result.draft).not.toContain('realcorp');
    expect(d.result.issues.map((i) => i.code)).toContain(Codes.SANITIZE_LEAK_DETECTED);
    expect(d.result.status).toBe('failed');
  });

  it('fails closed: no provider call when the sanitizer throws', async () => {
    const llm = scriptedLlm(() => reply(GOOD()));
    const sanitizer = await import('@/sanitizer/secrets');
    const { vi } = await import('vitest');
    const spy = vi.spyOn(sanitizer, 'secretPass').mockImplementation(() => {
      throw new Error('boom');
    });
    const err = await convert(SIMPLE_PLSQL, testProviders({ llm })).catch((e) => e);
    spy.mockRestore();
    expect(err.code).toBe(Codes.SANITIZE_LEAK_DETECTED);
    expect(llm.calls).toHaveLength(0);
  });

  it('pauses at the request budget and resumes from the next stage without a repair attempt', async () => {
    const { intake, continueRun } = await import('@/agents/orchestrator');
    const { createLogger } = await import('@/lib/logger');
    const providers = testProviders({ llm: scriptedLlm((r) => (r.task.kind === 'generate' ? reply(GOOD()) : MOCK)) });
    const deps = { providers, log: createLogger() };
    const run = await intake(SIMPLE_PLSQL, 'auto', { generateConfig: false }, deps, { budgetMs: 60000 });
    await continueRun(run, deps, { budgetMs: -1 }); // budget already spent: nothing starts
    expect(run.state).toBe('drafting');
    expect(run.drafts).toHaveLength(0);
    const stored = (await providers.storage.getRun(run.id))!; // a later request works from storage only
    await continueRun(stored, deps, { budgetMs: 60000 });
    expect(stored.state).toBe('draft_ready');
    expect(stored.drafts[0].result.attempts).toBe(0);
  });
});
