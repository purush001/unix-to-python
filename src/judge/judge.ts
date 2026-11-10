import { z } from 'zod';
import { DATA_GUARD, HONESTY_RULE, promptVersion } from '@/agents/prompts';
import { getConfig, getConfigInt } from '@/config/env';
import { ProviderError } from '@/lib/errors';
import { nowIso } from '@/lib/util';
import type { Change, JudgeScore, Platform } from '@/pipeline/types';
import type { LlmProvider, LlmResponse } from '@/providers/types';

/**
 * S14 / S15. LLM-as-judge for what code cannot check: faithfulness of the draft to the
 * source. The judge has its own prompt, a rubric of yes-or-no criteria, and a structured
 * verdict that gives evidence before each answer. The score is computed in code.
 * A judge is never the only gate for safety: leaks, secrets, syntax and policy codes are
 * checked by code graders.
 */
export const JUDGE_CRITERIA = {
  F1: 'Every statement or step of the source has an equivalent in the draft (nothing was dropped).',
  F2: 'Transaction boundaries are unchanged: every COMMIT and ROLLBACK is in the same place relative to the work around it.',
  F3: 'Error behaviour and exit codes are unchanged: the draft fails, continues and exits with the same codes as the source in the same situations.',
  F4: 'Every table, view, procedure, file path, host placeholder and variable the draft uses either appears in the source or is explained by an item in the change list.',
  F5: 'Every item in the change list is actually present in the draft at the lines it names.',
  F6: 'Every behavioural difference between source and draft is listed in the change list (there is no silent change).',
} as const;
export type CriterionId = keyof typeof JUDGE_CRITERIA;
export const CRITERION_IDS = Object.keys(JUDGE_CRITERIA) as CriterionId[];

export const JUDGE_SYSTEM = `You are an evaluation judge for script conversions. Your task: decide, criterion by criterion, whether a converted draft is faithful to its sanitized source script. You grade; you never rewrite or fix the script.

Rules
1. Answer each criterion with "yes", "no" or "unknown". The answers are counted by code, so do not give an overall score or opinion.
2. For each criterion write the evidence first, then the verdict. Evidence quotes or names the source line and the draft line it rests on, because a verdict without evidence cannot be audited.
3. Expected additions are not differences: error-capture handlers that re-raise, SET SERVEROUTPUT ON, and the standard Python runtime (logging, config file, error email).
4. Judge only what the criterion asks. Style, naming and performance are not graded here.

Criteria
${CRITERION_IDS.map((id) => `${id}. ${JUDGE_CRITERIA[id]}`).join('\n')}

${HONESTY_RULE}

${DATA_GUARD}

When you cannot comply. If the supplied text does not let you decide a criterion, answer "unknown" for it and say in the evidence what is missing. Never guess a "yes" or a "no".

Reply with exactly:
<verdict>
{"criteria": [{"id": "F1", "evidence": string, "verdict": "yes" | "no" | "unknown"}, ... one item per criterion, in order]}
</verdict>

Example of one item:
{"id": "F2", "evidence": "Source line 14 commits inside the loop; draft line 22 commits once after END LOOP.", "verdict": "no"}`;

export const judgePromptVersion = (): string => promptVersion(JUDGE_SYSTEM);

const VerdictSchema = z.object({
  criteria: z.array(z.object({ id: z.enum(CRITERION_IDS as [CriterionId, ...CriterionId[]]), evidence: z.string(), verdict: z.enum(['yes', 'no', 'unknown']) })).min(1),
});

/** Parses the judge's verdict. Anything that does not match the schema is a transient provider error. */
export function parseVerdict(text: string): JudgeScore['criteria'] {
  const open = text.indexOf('<verdict>');
  const close = text.lastIndexOf('</verdict>');
  if (open === -1 || close < open) throw new ProviderError('llm', 'malformed', 200, 'Judge output has no <verdict> section');
  let v: unknown;
  try {
    v = JSON.parse(text.slice(open + 9, close));
  } catch {
    throw new ProviderError('llm', 'malformed', 200, 'Judge verdict is not JSON');
  }
  const parsed = VerdictSchema.safeParse(v);
  if (!parsed.success) throw new ProviderError('llm', 'malformed', 200, 'Judge verdict does not match the schema');
  const seen = new Set<string>();
  const criteria = parsed.data.criteria.filter((c) => !seen.has(c.id) && seen.add(c.id));
  // a criterion the judge skipped is unknown, not a pass
  for (const id of CRITERION_IDS) if (!seen.has(id)) criteria.push({ id, evidence: 'The judge gave no answer for this criterion.', verdict: 'unknown' });
  return criteria.sort((a, b) => a.id.localeCompare(b.id));
}

/** Share of decided criteria answered "yes". Unknown answers are excluded, and reported separately. */
export function scoreOf(criteria: JudgeScore['criteria']): number | null {
  const decided = criteria.filter((c) => c.verdict !== 'unknown');
  return decided.length ? Number((decided.filter((c) => c.verdict === 'yes').length / decided.length).toFixed(4)) : null;
}

export interface JudgeInput {
  platform: Platform;
  source: string;
  draft: string;
  changes: Change[];
  draftVersion: number;
}

export function judgeUserPrompt(i: JudgeInput): string {
  return `Platform: ${i.platform === 'plsql' ? 'Oracle SQL, PL/SQL or SQL*Plus' : 'ksh/bash shell converted to Python 3.11+'}\n\n<source>\n${i.source}\n</source>\n<draft>\n${i.draft}\n</draft>\n<change_list>\n${JSON.stringify(i.changes)}\n</change_list>`;
}

/** One judge call. The judge model is pinned by JUDGE_MODEL, separately from the conversion model. */
export async function judgeDraft(llm: LlmProvider, i: JudgeInput): Promise<{ score: JudgeScore; response: LlmResponse }> {
  const response = await llm.complete({
    system: JUDGE_SYSTEM,
    user: judgeUserPrompt(i),
    timeoutMs: getConfigInt('LLM_AUX_TIMEOUT_MS'),
    maxTokens: getConfigInt('LLM_JUDGE_MAX_TOKENS'),
    model: getConfig('JUDGE_MODEL'),
    task: { kind: 'judge', platform: i.platform, payload: { source: i.source, draft: i.draft } },
  });
  let criteria: JudgeScore['criteria'];
  try {
    criteria = parseVerdict(response.text);
  } catch (e) {
    if (e instanceof ProviderError) e.response = response;
    throw e;
  }
  return { score: { score: scoreOf(criteria), criteria, model: response.model, promptVersion: judgePromptVersion(), draftVersion: i.draftVersion, at: nowIso() }, response };
}
