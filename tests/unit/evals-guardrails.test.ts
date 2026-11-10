import { beforeEach, describe, expect, it } from 'vitest';
import { compareWithBaseline, toBaseline, type Baseline } from '@evals/baseline';
import { kappa } from '@evals/calibrate';
import { loadFixtures, runFixture, SEEDS, summarize, type FixtureResult } from '@evals/suite';
import { classify } from '@/agents/orchestrator';
import { parseVerdict, scoreOf } from '@/judge/judge';
import { ProviderError } from '@/lib/errors';
import { sanitize, scanSanitized } from '@/sanitizer';
import { freshDb, testProviders } from '../helpers';

beforeEach(freshDb);

const VERSIONS: Baseline['versions'] = { model: 'mock', effort: 'high', judgeModel: 'mock', prompts: {} };
const res = (id: string, over: Partial<FixtureResult> = {}): FixtureResult => ({ id, hash: 'h', kind: 'golden', status: 'ok', errorCodes: [], warningCodes: [], attempts: 0, transientRetries: 0, leaks: 0, secrets: 0, seedHits: [], syntaxOk: true, dualHits: 0, inventedRuleIds: [], judgeScore: null, judgeFailed: [], judgeUnknown: 0, failedChecks: [], pass: true, outputs: [], ...over });
const base = (rs: FixtureResult[]) => toBaseline(rs, summarize(rs), VERSIONS);

describe('S13 input guardrails: wrong content type', () => {
  it('rejects HTML, JSON, Python and binary input even when it contains SQL words', () => {
    const cases: Record<string, string> = {
      html: '<!DOCTYPE html>\n<html><body><p>select the update; delete from list;</p></body></html>',
      json: JSON.stringify({ query: "select * from ps_job where emplid = '1';" }, null, 2),
      python: 'import sys\n\ndef main():\n    print("select 1 from dual;")\n\nif __name__ == "__main__":\n    sys.exit(main())\n',
      pdf: '%PDF-1.7\n1 0 obj\nselect 1 from dual;\n',
      binary: 'select 1 from dual;\u0000\u0001\n',
    };
    for (const [k, v] of Object.entries(cases)) expect(classify(v).type, k).toBe('unsupported');
  });

  it('still accepts real scripts that only look similar', () => {
    expect(classify('#!/bin/ksh\n[ -f /tmp/x ] && echo found\nexit 0\n').type).toBe('shell');
    expect(classify("SELECT '{\"a\": 1}' FROM DUAL;\n").type).toBe('sql');
    expect(classify("BEGIN\n  DBMS_OUTPUT.PUT_LINE('<html>');\nEND;\n/\n").type).toBe('plsql');
    // a literal ESC byte (colour codes) is ordinary in shell scripts
    expect(classify('#!/bin/sh\necho "\u001B[31mfailed\u001B[0m"\nexit 1\n').type).toBe('shell');
    // a user-selected type cannot override a wrong content type
    expect(classify('<!DOCTYPE html><html></html>', 'sql').type).toBe('unsupported');
  });
});

describe('S13 input guardrails: encoding tricks', () => {
  it('finds an e-mail address hidden by percent-encoding or full-width characters, and a percent-encoded host', () => {
    const s = sanitize('-- owner mokafor%40northwind-hr.com and ｍｏｋａｆｏｒ＠northwind-hr.com\n-- scp to pshcmprd01%2Enorthwind-hr%2Ecom\nSELECT 1 FROM DUAL;\n', 'sql');
    for (const seed of ['mokafor', 'northwind-hr.com', 'pshcmprd01']) expect(s.text).not.toContain(seed);
    expect(s.text).toContain('ops@script.com');
    expect(s.warnings.map((w) => w.code)).toContain('SANITIZE_OBFUSCATION_NORMALIZED');
  });

  it('removes invisible characters, reports them, and treats them as a hit in output', () => {
    const s = sanitize('-- ig​nore‮ this\nSELECT 1 FROM DUAL;\n', 'sql');
    expect(s.text).toBe('-- ignore this\nSELECT 1 FROM DUAL;\n');
    expect(s.warnings.map((w) => w.code)).toEqual(['SANITIZE_OBFUSCATION_NORMALIZED']);
    expect(scanSanitized('SELECT 1​ FROM DUAL;\n', 'sql')).toHaveLength(1);
  });

  it('does not decode ordinary text: date formats and LIKE patterns are untouched', () => {
    const src = "LOG=/tmp/run_$(date +%Y%m%d).log\nprintf '%40s\\n' \"$x\"\nsqlplus -s / <<EOF\nSELECT 1 FROM DUAL WHERE x LIKE '%40%';\nEOF\n";
    const s = sanitize(src, 'shell');
    expect(s.text).toBe(src);
    expect(s.warnings).toEqual([]);
  });
});

describe('S14 attack suite', () => {
  it('every adversarial fixture is blocked or neutralised on the mock provider, and no seeded value survives', async () => {
    const attacks = loadFixtures().filter((f) => f.kind === 'adversarial');
    expect(attacks.length).toBeGreaterThanOrEqual(11);
    const results = [];
    for (const fx of attacks) results.push(await runFixture(fx, testProviders(), { keepOutputs: true }));
    expect(results.filter((r) => !r.pass).map((r) => `${r.id}: ${r.failedChecks.join('; ')}`)).toEqual([]);
    const all = JSON.stringify(results);
    expect(SEEDS.filter((s) => all.includes(s))).toEqual([]);
    expect(summarize(results).attacks).toEqual({ total: attacks.length, blocked: attacks.length, blockRate: 1 });
  });
});

describe('S14 regression gate', () => {
  it('reports nothing when the run matches the baseline', () => {
    const rs = [res('a'), res('b', { kind: 'adversarial' })];
    expect(compareWithBaseline(base(rs), base(rs))).toEqual([]);
  });

  it('blocks a fixture that now fails, a removed fixture, new error codes and a falling judge score', () => {
    const before = base([res('a', { judgeScore: 1 }), res('b'), res('c'), res('d', { kind: 'adversarial' })]);
    const after = base([res('a', { judgeScore: 0.5 }), res('b', { pass: false, failedChecks: ['x'] }), res('d', { kind: 'adversarial', pass: false, errorCodes: ['SECRET_IN_OUTPUT'] })]);
    const r = compareWithBaseline(before, after);
    expect(r).toEqual(expect.arrayContaining(['a: judge score fell (1 -> 0.5)', 'b: passed in the baseline, fails now', 'c: in the baseline but no longer run', 'd: passed in the baseline, fails now']));
    expect(r.some((x) => x.startsWith('attack block rate fell'))).toBe(true);
    expect(r.some((x) => x.startsWith('validator pass rate fell'))).toBe(true);
    expect(r.some((x) => x.startsWith('mean judge score fell'))).toBe(true);
  });

  it('an improvement is not a regression', () => {
    expect(compareWithBaseline(base([res('a', { pass: false, errorCodes: ['PY_SYNTAX_ERROR'] })]), base([res('a')]))).toEqual([]);
  });
});

describe('S14 judge', () => {
  it('computes the score in code from yes/no answers and leaves unknown out', () => {
    const c = parseVerdict('<verdict>{"criteria":[{"id":"F1","evidence":"e","verdict":"yes"},{"id":"F2","evidence":"e","verdict":"no"},{"id":"F3","evidence":"e","verdict":"unknown"}]}</verdict>');
    expect(c.map((x) => x.id)).toEqual(['F1', 'F2', 'F3', 'F4', 'F5', 'F6']);
    // criteria the judge skipped are unknown, never a pass
    expect(c.slice(3).every((x) => x.verdict === 'unknown')).toBe(true);
    expect(scoreOf(c)).toBe(0.5);
    expect(scoreOf(c.filter((x) => x.verdict === 'unknown'))).toBeNull();
  });

  it('rejects a verdict outside the schema', () => {
    expect(() => parseVerdict('<verdict>{"criteria":[{"id":"F9","evidence":"e","verdict":"yes"}]}</verdict>')).toThrow(ProviderError);
    expect(() => parseVerdict('<verdict>{"criteria":[{"id":"F1","evidence":"e","verdict":"probably"}]}</verdict>')).toThrow(ProviderError);
    expect(() => parseVerdict('score: 9/10')).toThrow(ProviderError);
  });

  it("Cohen's kappa for calibration", () => {
    expect(kappa([['yes', 'yes'], ['no', 'no'], ['yes', 'yes'], ['no', 'no']])).toBe(1);
    expect(kappa([['yes', 'no'], ['no', 'yes'], ['yes', 'yes'], ['no', 'no']])).toBe(0);
    expect(kappa([['yes', 'yes'], ['yes', 'yes']])).toBeNull();
    expect(kappa([])).toBeNull();
  });
});
