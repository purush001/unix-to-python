import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { getConfig } from '@/config/env';
import { CRITERION_IDS, judgeDraft, judgePromptVersion, type CriterionId } from '@/judge/judge';
import { createProviders } from '@/providers';
import { createMockLlm } from '@/providers/llm/mock';
import { scanSanitized, scanSecrets } from '@/sanitizer';

/**
 * `npm run eval:calibrate` — compares the judge with human labels (S14).
 * Labels live in evals/judge/labels.json. The judge counts as calibrated only with at
 * least MIN_CASES human-labelled cases; below that this script reports "not calibrated".
 * Mock judge by default; EVAL_REAL_PROVIDER=1 uses the configured provider and JUDGE_MODEL.
 */
export const MIN_CASES = 30;
const LABELS = path.join('evals', 'judge', 'labels.json');
const REPORT = path.join('evals', 'judge', 'calibration-report.json');

const Verdict = z.enum(['yes', 'no']);
const CaseSchema = z.object({
  id: z.string().min(1),
  platform: z.enum(['plsql', 'shell-python']),
  source: z.string().min(1),
  draft: z.string().min(1),
  changes: z.array(z.object({ ruleId: z.string(), lines: z.string(), summary: z.string(), reason: z.string(), risk: z.enum(['low', 'medium', 'high']) })),
  /** A human's answer per criterion. Leave a criterion out when the human could not decide. */
  labels: z.partialRecord(z.enum(CRITERION_IDS as [CriterionId, ...CriterionId[]]), Verdict),
  labelledBy: z.string().min(1),
});
export type LabelledCase = z.infer<typeof CaseSchema>;

/** Cohen's kappa for two raters over yes/no answers; null when it is undefined (no variation). */
export function kappa(pairs: [string, string][]): number | null {
  if (!pairs.length) return null;
  const n = pairs.length;
  const agree = pairs.filter(([a, b]) => a === b).length / n;
  const pa = pairs.filter(([a]) => a === 'yes').length / n;
  const pb = pairs.filter(([, b]) => b === 'yes').length / n;
  const chance = pa * pb + (1 - pa) * (1 - pb);
  return chance === 1 ? null : Number(((agree - chance) / (1 - chance)).toFixed(4));
}

async function main(): Promise<void> {
  const real = getConfig('EVAL_REAL_PROVIDER') === '1';
  const cases = z.array(CaseSchema).parse(existsSync(LABELS) ? JSON.parse(readFileSync(LABELS, 'utf8')) : []);
  for (const c of cases) if (scanSanitized(c.source).length || scanSecrets(c.source).length || scanSanitized(c.draft).length || scanSecrets(c.draft).length) throw new Error(`Labelled case ${c.id} is not sanitized; remove the protected item before it is committed or sent to a provider.`);
  const llm = real ? createProviders().llm : createMockLlm();
  const pairs: [string, string][] = [];
  const perCriterion: Record<string, { compared: number; agreed: number; judgeUnknown: number }> = Object.fromEntries(CRITERION_IDS.map((id) => [id, { compared: 0, agreed: 0, judgeUnknown: 0 }]));
  let failedCalls = 0;
  for (const c of cases) {
    let verdicts: Record<string, string>;
    try {
      const j = await judgeDraft(llm, { platform: c.platform, source: c.source, draft: c.draft, changes: c.changes, draftVersion: 1 });
      verdicts = Object.fromEntries(j.score.criteria.map((x) => [x.id, x.verdict]));
    } catch {
      failedCalls++;
      continue;
    }
    for (const id of CRITERION_IDS) {
      const human = c.labels[id];
      if (!human) continue;
      if (verdicts[id] === 'unknown' || !verdicts[id]) {
        perCriterion[id].judgeUnknown++;
        continue;
      }
      perCriterion[id].compared++;
      if (verdicts[id] === human) perCriterion[id].agreed++;
      pairs.push([human, verdicts[id]]);
    }
  }
  const compared = pairs.length;
  const agreed = pairs.filter(([a, b]) => a === b).length;
  const calibrated = cases.length >= MIN_CASES && failedCalls === 0;
  const report = {
    judgeModel: real ? getConfig('JUDGE_MODEL') : 'mock', judgePromptVersion: judgePromptVersion(), cases: cases.length, minCases: MIN_CASES,
    status: calibrated ? 'calibrated' : `not calibrated: ${cases.length} of ${MIN_CASES} human-labelled cases${failedCalls ? `, ${failedCalls} judge call(s) failed` : ''}`,
    comparedAnswers: compared, agreement: compared ? Number((agreed / compared).toFixed(4)) : null, cohenKappa: kappa(pairs), failedCalls, perCriterion,
  };
  console.log(`\nJudge calibration (${report.judgeModel}, prompt ${report.judgePromptVersion})`);
  console.log(`  status: ${report.status}`);
  console.log(`  agreement with human labels: ${report.agreement ?? 'n/a'} over ${compared} answers; Cohen's kappa ${report.cohenKappa ?? 'n/a'}`);
  for (const [id, p] of Object.entries(perCriterion)) if (p.compared || p.judgeUnknown) console.log(`    ${id}: ${p.agreed}/${p.compared} agreed, judge said "unknown" ${p.judgeUnknown} time(s)`);
  if (process.argv.includes('--write')) {
    writeFileSync(REPORT, JSON.stringify(report, null, 2) + '\n');
    console.log(`  report written to ${REPORT}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('evals', 'calibrate.ts')) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
