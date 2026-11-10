import type { EvalSummary, FixtureResult } from './suite';

/** What is committed in evals/baseline.json for one provider key. No timestamps: the file is stable. */
export interface Baseline {
  versions: { model: string; effort: string; judgeModel: string; prompts: Record<string, string> };
  metrics: { fixtures: number; passed: number; validatorPassRate: number; repairRate: number; attackBlockRate: number; judgeMeanScore: number | null };
  fixtures: Record<string, { pass: boolean; status: string; errorCodes: string[]; judgeScore: number | null }>;
}
export interface BaselineFile {
  note: string;
  baselines: Record<string, Baseline>;
}

export function toBaseline(results: FixtureResult[], summary: EvalSummary, versions: Baseline['versions']): Baseline {
  return {
    versions,
    metrics: { fixtures: summary.fixtures, passed: summary.passed, validatorPassRate: summary.validatorPassRate, repairRate: summary.repairRate, attackBlockRate: summary.attacks.blockRate, judgeMeanScore: summary.judge.meanScore },
    fixtures: Object.fromEntries(results.map((r) => [r.id, { pass: r.pass, status: r.status, errorCodes: r.errorCodes, judgeScore: r.judgeScore }])),
  };
}

/** Every way the current run is worse than the baseline. An empty list means no regression. */
export function compareWithBaseline(base: Baseline, now: Baseline): string[] {
  const out: string[] = [];
  for (const [id, b] of Object.entries(base.fixtures)) {
    const n = now.fixtures[id];
    if (!n) out.push(`${id}: in the baseline but no longer run`);
    else if (b.pass && !n.pass) out.push(`${id}: passed in the baseline, fails now`);
    else if (n.errorCodes.length > b.errorCodes.length) out.push(`${id}: more error codes (${b.errorCodes.length} -> ${n.errorCodes.length})`);
    else if (b.judgeScore !== null && n.judgeScore !== null && n.judgeScore < b.judgeScore) out.push(`${id}: judge score fell (${b.judgeScore} -> ${n.judgeScore})`);
  }
  const m = base.metrics;
  const c = now.metrics;
  if (c.validatorPassRate < m.validatorPassRate) out.push(`validator pass rate fell (${m.validatorPassRate} -> ${c.validatorPassRate})`);
  if (c.attackBlockRate < m.attackBlockRate) out.push(`attack block rate fell (${m.attackBlockRate} -> ${c.attackBlockRate})`);
  if (c.repairRate > m.repairRate) out.push(`repair rate rose (${m.repairRate} -> ${c.repairRate})`);
  if (m.judgeMeanScore !== null && c.judgeMeanScore !== null && c.judgeMeanScore < m.judgeMeanScore) out.push(`mean judge score fell (${m.judgeMeanScore} -> ${c.judgeMeanScore})`);
  if (m.judgeMeanScore !== null && c.judgeMeanScore === null) out.push('the judge decided nothing, but the baseline has a judge score');
  return out;
}
