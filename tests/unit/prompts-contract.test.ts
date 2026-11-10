import { beforeEach, describe, expect, it } from 'vitest';
import { ADAPTERS } from '@/adapters';
import { reviewerPromptVersion } from '@/agents/agent';
import { OUTPUT_FORMAT, parseAgentOutput, parseReviewOutput, parseRuleOutput } from '@/agents/format';
import { DATA_GUARD, HONESTY_RULE, promptVersion, REVIEWER_SYSTEM, RULE_WRITER_SYSTEM } from '@/agents/prompts';
import { JUDGE_SYSTEM } from '@/judge/judge';
import { ProviderError } from '@/lib/errors';
import { unknownRuleIds } from '@/pipeline/engine';
import { convert, freshDb, MOCK, scriptedLlm, SIMPLE_PLSQL, testProviders } from '../helpers';

const SYSTEM_PROMPTS: Record<string, string> = {
  'sql-agent': ADAPTERS.plsql.systemPrompt(),
  'shell-agent': ADAPTERS['shell-python'].systemPrompt(),
  reviewer: REVIEWER_SYSTEM,
  'rule-writer': RULE_WRITER_SYSTEM,
  judge: JUDGE_SYSTEM,
};
const wrap = (changes: unknown, extra = '') => `<converted>\nSELECT 1 FROM DUAL;\n</converted>\n<changes>\n${JSON.stringify(changes)}\n</changes>\n${extra}`;

beforeEach(freshDb);

describe('S4 system prompts', () => {
  it('every system prompt, judge included, carries HONESTY_RULE verbatim and the data guard', () => {
    for (const [role, p] of Object.entries(SYSTEM_PROMPTS)) {
      expect(p, role).toContain(HONESTY_RULE);
      expect(p, role).toContain(DATA_GUARD);
    }
  });

  it('keeps the fixed order: rules, HONESTY_RULE, data guard, what to do when it cannot comply, output format', () => {
    for (const [role, p] of Object.entries(SYSTEM_PROMPTS)) {
      const at = [p.indexOf('Rules\n'), p.indexOf(HONESTY_RULE), p.indexOf(DATA_GUARD), p.indexOf('When you cannot comply'), p.indexOf('Reply with exactly')];
      expect(at.every((i) => i >= 0), role).toBe(true);
      expect([...at].sort((a, b) => a - b), role).toEqual(at);
    }
  });

  it('gives each prompt a stable version hash that changes when the prompt changes', () => {
    const v = promptVersion(REVIEWER_SYSTEM);
    expect(v).toMatch(/^[0-9a-f]{12}$/);
    expect(promptVersion(REVIEWER_SYSTEM)).toBe(v);
    expect(reviewerPromptVersion()).toBe(v);
    expect(promptVersion(REVIEWER_SYSTEM + ' ')).not.toBe(v);
  });

  it('the output format ends with examples', () => {
    expect(OUTPUT_FORMAT.indexOf('Example')).toBeGreaterThan(OUTPUT_FORMAT.indexOf('<unknown>'));
  });
});

describe('S7 structured output', () => {
  it('accepts a well-formed reply and reads the unknown signal', () => {
    const o = parseAgentOutput(wrap([{ ruleId: 'dual-compat', lines: 3, summary: 's', reason: 'r', risk: 'low' }], '<unknown>\n[{"sourceLine": 4, "missing": "load_env.sh was not supplied"}]\n</unknown>'));
    expect(o.changes[0]).toEqual({ ruleId: 'dual-compat', lines: '3', summary: 's', reason: 'r', risk: 'low' });
    expect(o.unknowns).toEqual([{ sourceLine: 4, missing: 'load_env.sh was not supplied' }]);
  });

  it('rejects metadata that does not match the schema as a transient provider error, never a silent default', () => {
    for (const bad of [[{ lines: '1', summary: 's', reason: 'r', risk: 'low' }], [{ ruleId: 'x', lines: '1', summary: 's', reason: 'r', risk: 'extreme' }], { ruleId: 'x' }, [42]]) {
      const err = (() => {
        try {
          return parseAgentOutput(wrap(bad));
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(ProviderError);
      expect([(err as ProviderError).failure, (err as ProviderError).transient]).toEqual(['malformed', true]);
    }
  });

  it('rejects a review code outside the closed set instead of dropping it', () => {
    expect(() => parseReviewOutput('<review>[{"code":"REVIEW_MADE_UP","message":"m","line":1}]</review>')).toThrow(ProviderError);
    expect(parseReviewOutput('<review>[{"code":"REVIEW_UNKNOWN","message":"cannot tell","line":2,"sourceLine":null}]</review>')[0]).toMatchObject({ code: 'REVIEW_UNKNOWN', severity: 'warning', line: 2 });
  });

  it('the rule writer can answer "unknown" and malformed rules are discarded', () => {
    expect(parseRuleOutput('<rule>{"unknown": true}</rule>')).toBeNull();
    expect(parseRuleOutput('<rule>{"trigger": "not-an-array", "guidance": "g"}</rule>')).toBeNull();
    expect(parseRuleOutput('<rule>{"trigger": ["a"], "guidance": "g", "example": {"before": "b", "after": "a"}}</rule>')?.guidance).toBe('g');
  });
});

describe('S14 hallucination checks', () => {
  it('accepts supplied guidance ids, built-in ids and issue codes; flags anything else', () => {
    const unit = { platform: 'plsql' as const, guidance: [{ id: 'learned-plsql_abc', kind: 'rule' as const, text: 't' }], changes: ['learned-plsql_abc', 'dual-compat', 'SQL_NO_COMMON_FORM', 'reviewer-note', 'unspecified', 'rule-i-made-up'].map((ruleId) => ({ ruleId, lines: '1', summary: '', reason: '', risk: 'low' as const })) };
    expect(unknownRuleIds(unit)).toEqual(['rule-i-made-up']);
  });

  it('an invented rule id is an error, triggers a repair, and the repair hint names the allowed ids', async () => {
    const llm = scriptedLlm((req, i) => (i === 0 ? wrap([{ ruleId: 'rule-i-made-up', lines: '1', summary: 's', reason: 'r', risk: 'low' }]).replace('SELECT 1 FROM DUAL;', SIMPLE_PLSQL) : MOCK));
    const run = await convert(SIMPLE_PLSQL, testProviders({ llm }));
    const unit = run.units[0];
    expect(unit.stageCodes[0].validate).toContain('CHANGE_RULE_UNKNOWN');
    expect(llm.calls[1].task.kind).toBe('repair');
    expect(llm.calls[1].user).toContain('CHANGE_RULE_UNKNOWN');
    expect(run.drafts[0].result.issues.map((x) => x.code)).not.toContain('CHANGE_RULE_UNKNOWN');
  });

  it('the unknown signal reaches the reviewer as a warning with the source line', async () => {
    const llm = scriptedLlm(async (req, i) => {
      if (i !== 0) return MOCK;
      const mock = await testProviders().llm.complete(req);
      return mock.text.replace(/<unknown>[\s\S]*<\/unknown>/, '<unknown>\n[{"sourceLine": 2, "missing": "The spool directory is not defined in the script."}]\n</unknown>');
    });
    const run = await convert(SIMPLE_PLSQL, testProviders({ llm }));
    const w = run.drafts[0].result.issues.find((x) => x.code === 'CONVERT_UNKNOWN');
    expect(w).toMatchObject({ severity: 'warning', sourceLine: 2, message: 'The spool directory is not defined in the script.' });
  });
});
