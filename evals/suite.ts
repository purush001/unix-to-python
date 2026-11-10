import { continueRun, intake } from '@/agents/orchestrator';
import { AppError } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { Codes, type IssueCode } from '@/pipeline/issue-codes';
import type { RunRecord, SkillRule } from '@/pipeline/types';
import type { Providers } from '@/providers/types';
import { langOfFile, scanSanitized, scanSecrets } from '@/sanitizer';
import { loadFixtures, SEEDS, type Fixture } from './fixtures';

export { loadFixtures, SEEDS };
export type { Fixture };

export interface FixtureResult {
  id: string;
  hash: string;
  kind: Fixture['kind'];
  status: string;
  errorCodes: IssueCode[];
  warningCodes: IssueCode[];
  attempts: number;
  transientRetries: number;
  leaks: number;
  secrets: number;
  seedHits: string[];
  syntaxOk: boolean;
  dualHits: number;
  failedChecks: string[];
  /** Hard gates and fixture expectations all hold. */
  pass: boolean;
  outputs: { name: string; content: string }[];
}
export interface EvalSummary {
  fixtures: number;
  passed: number;
  validatorPassRate: number;
  repairRate: number;
  transientRetries: number;
  warningsByCode: Record<string, number>;
  errorsByCode: Record<string, number>;
  gates: { zeroLeaks: boolean; zeroSecrets: boolean; allSyntaxOk: boolean; zeroDualCompatHits: boolean };
}

/** Runs one fixture through intake and the pipeline. Nothing is persisted and no script is executed. */
export async function runFixture(fx: Fixture, providers: Providers, opts: { extraRules?: SkillRule[]; keepOutputs?: boolean } = {}): Promise<FixtureResult> {
  const deps = { providers, log: createLogger() };
  const limits = { budgetMs: 10 * 60 * 1000, persist: false, extraRules: opts.extraRules, retryBaseMs: 1 };
  const base: FixtureResult = { id: fx.id, hash: fx.hash, kind: fx.kind, status: 'rejected', errorCodes: [], warningCodes: [], attempts: 0, transientRetries: 0, leaks: 0, secrets: 0, seedHits: [], syntaxOk: true, dualHits: 0, failedChecks: [], pass: false, outputs: [] };
  let run: RunRecord;
  try {
    run = await intake(fx.source, 'auto', { generateConfig: true }, deps, limits);
    run = await continueRun(run, deps, limits);
  } catch (e) {
    const code = e instanceof AppError ? e.code : 'ERROR';
    base.status = `rejected:${code}`;
    if (fx.expectReject !== code) base.failedChecks.push(fx.expectReject ? `expected rejection ${fx.expectReject}, got ${code}` : `unexpected failure ${code}: ${e instanceof Error ? e.message : ''}`);
    base.pass = base.failedChecks.length === 0;
    return base;
  }
  const d = run.drafts[run.drafts.length - 1];
  const r = d.result;
  const out = { ...base, status: r.status, attempts: r.attempts, transientRetries: r.witness.transientRetries };
  out.errorCodes = [...new Set(r.issues.filter((i) => i.severity === 'error').map((i) => i.code))].sort();
  out.warningCodes = [...new Set(r.issues.filter((i) => i.severity === 'warning').map((i) => i.code))].sort();
  const everything = [...d.files.map((f) => ({ name: f.name, content: f.content })), { name: 'source.sanitized', content: run.sanitizedSource }, { name: 'meta.json', content: JSON.stringify({ changes: r.changes, issues: r.issues, suggestions: d.suggestions, witness: r.witness }) }];
  for (const f of everything) {
    out.leaks += scanSanitized(f.content, f.name === 'source.sanitized' ? (run.platform === 'plsql' ? 'sql' : 'shell') : langOfFile(f.name), []).length;
    out.secrets += scanSecrets(f.content, f.name === 'source.sanitized' ? (run.platform === 'plsql' ? 'sql' : 'shell') : langOfFile(f.name)).length;
    for (const s of SEEDS) if (f.content.includes(s) && !out.seedHits.includes(s)) out.seedHits.push(s);
  }
  out.syntaxOk = r.witness.syntax.every((s) => s.ok);
  out.dualHits = r.issues.filter((i) => i.code === Codes.SQL_NOT_DUAL_COMPATIBLE).length;
  if (fx.expectReject) out.failedChecks.push(`expected rejection ${fx.expectReject}, but the input was converted`);
  if (fx.expectType && run.scriptType !== fx.expectType) out.failedChecks.push(`expected type ${fx.expectType}, got ${run.scriptType}`);
  const codes = new Set(r.issues.map((i) => i.code));
  for (const c of fx.mustHave ?? []) if (!codes.has(c)) out.failedChecks.push(`missing expected code ${c}`);
  for (const c of fx.mustNotHave ?? []) if (codes.has(c)) out.failedChecks.push(`unexpected code ${c}`);
  for (const re of fx.outputMatches ?? []) if (!re.test(d.files[0].content)) out.failedChecks.push(`output does not match ${re}`);
  for (const re of fx.outputLacks ?? []) if (re.test(d.files[0].content)) out.failedChecks.push(`output must not match ${re}`);
  if (out.leaks) out.failedChecks.push(`${out.leaks} sanitizer leak(s)`);
  if (out.secrets) out.failedChecks.push(`${out.secrets} secret(s) in output`);
  if (out.seedHits.length) out.failedChecks.push(`${out.seedHits.length} seeded value(s) survived`);
  if (!out.syntaxOk) out.failedChecks.push('syntax check failed');
  if (out.dualHits) out.failedChecks.push(`${out.dualHits} dual-compatibility hit(s)`);
  out.pass = out.failedChecks.length === 0;
  if (opts.keepOutputs) out.outputs = d.files.map((f) => ({ name: f.name, content: f.content }));
  return out;
}

export function summarize(results: FixtureResult[]): EvalSummary {
  const converted = results.filter((r) => !r.status.startsWith('rejected'));
  const tally = (pick: (r: FixtureResult) => string[]) => {
    const m: Record<string, number> = {};
    for (const r of results) for (const c of pick(r)) m[c] = (m[c] ?? 0) + 1;
    return m;
  };
  return {
    fixtures: results.length,
    passed: results.filter((r) => r.pass).length,
    validatorPassRate: converted.length ? converted.filter((r) => r.errorCodes.length === 0).length / converted.length : 1,
    repairRate: converted.length ? converted.filter((r) => r.attempts > 0).length / converted.length : 0,
    transientRetries: results.reduce((s, r) => s + r.transientRetries, 0),
    warningsByCode: tally((r) => r.warningCodes),
    errorsByCode: tally((r) => r.errorCodes),
    gates: {
      zeroLeaks: results.every((r) => r.leaks === 0 && r.seedHits.length === 0),
      zeroSecrets: results.every((r) => r.secrets === 0),
      allSyntaxOk: results.every((r) => r.syntaxOk),
      zeroDualCompatHits: results.every((r) => r.dualHits === 0),
    },
  };
}
