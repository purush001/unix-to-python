import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { reviewerPromptVersion } from '@/agents/agent';
import { ADAPTERS } from '@/adapters';
import { promptVersion } from '@/agents/prompts';
import { getConfig } from '@/config/env';
import { judgePromptVersion } from '@/judge/judge';
import { Codes } from '@/pipeline/issue-codes';
import { createProviders } from '@/providers';
import { createMockEmbeddings } from '@/providers/embeddings/mock';
import { createMockGitHub } from '@/providers/github/mock';
import { createMockLlm } from '@/providers/llm/mock';
import { createMockMemory } from '@/providers/memory/mock';
import { createMockSmtp } from '@/providers/smtp/mock';
import { createMockStorage } from '@/providers/storage/mock';
import { langOfFile, scanSanitized, scanSecrets } from '@/sanitizer';
import { compareWithBaseline, toBaseline, type Baseline, type BaselineFile } from './baseline';
import { loadFixtures, runFixture, summarize, type FixtureResult } from './suite';

const BASELINE_PATH = path.join('evals', 'baseline.json');
const TRAFFIC_DIR = path.join('evals', 'real-traffic');

/**
 * `npm run eval` — mocks by default; EVAL_REAL_PROVIDER=1 uses the configured LLM (never part of `npm test`).
 * Exits non-zero when a hard gate fails, a fixture fails, or any metric is below the committed baseline.
 * `npm run eval -- --update-baseline` rewrites the baseline for the provider in use.
 */
async function main(): Promise<void> {
  const real = getConfig('EVAL_REAL_PROVIDER') === '1';
  const updateBaseline = process.argv.includes('--update-baseline');
  const providers = createProviders({
    storage: createMockStorage(), github: createMockGitHub(), smtp: createMockSmtp(), memory: createMockMemory(), embeddings: createMockEmbeddings(),
    ...(real ? {} : { llm: createMockLlm() }),
  });
  let python: string | null = null;
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    python = 'python3';
  } catch {
    /* no interpreter: the WASM parser result stands alone */
  }
  const tmp = mkdtempSync(path.join(tmpdir(), 'modernizer-eval-'));
  const results: FixtureResult[] = [];
  const pyCompile: Record<string, boolean | null> = {};
  for (const fx of loadFixtures()) {
    const r = await runFixture(fx, providers, { keepOutputs: true, judge: true });
    const py = r.outputs.find((o) => o.name.endsWith('.py'));
    if (py && python) {
      const file = path.join(tmp, `${fx.id}.py`);
      writeFileSync(file, py.content);
      try {
        execFileSync(python, ['-I', '-m', 'py_compile', file], { stdio: 'pipe' }); // compiles only, never runs the script
        pyCompile[fx.id] = true;
      } catch {
        pyCompile[fx.id] = false;
        r.syntaxOk = false;
        r.failedChecks.push('python3 -m py_compile failed');
        r.pass = false;
      }
    } else if (py) pyCompile[fx.id] = null;
    results.push({ ...r, outputs: [] });
  }
  rmSync(tmp, { recursive: true, force: true });
  const summary = summarize(results);
  const gatesOk = Object.values(summary.gates).every(Boolean);

  // Real-traffic sample: genuine, already sanitized scripts. Measures guardrail false positives.
  const traffic = await realTraffic(providers);

  const providerKey = real ? `real:${getConfig('LLM_MODEL')}:${getConfig('LLM_EFFORT')}` : 'mock';
  const versions = { model: real ? getConfig('LLM_MODEL') : 'mock', effort: getConfig('LLM_EFFORT'), judgeModel: real ? getConfig('JUDGE_MODEL') : 'mock', prompts: { 'sql-agent': promptVersion(ADAPTERS.plsql.systemPrompt()), 'shell-agent': promptVersion(ADAPTERS['shell-python'].systemPrompt()), reviewer: reviewerPromptVersion(), judge: judgePromptVersion() } };
  const current: Baseline = toBaseline(results, summary, versions);
  const file: BaselineFile = existsSync(BASELINE_PATH) ? (JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as BaselineFile) : { note: '', baselines: {} };
  const baseline = file.baselines[providerKey] ?? null;
  const regressions = baseline ? compareWithBaseline(baseline, current) : [];

  const report = { generatedAt: new Date().toISOString(), provider: real ? 'configured' : 'mock', providerKey, versions, pythonInterpreter: python ? 'python3 -m py_compile' : 'not available', averageRating: null, summary, realTraffic: traffic, baseline: baseline ? { found: true, regressions } : { found: false, regressions: [] }, pyCompile, results };
  writeFileSync('eval-report.json', JSON.stringify(report, null, 2) + '\n');
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
  console.log(`\nEval (${report.provider} provider): ${summary.passed}/${summary.fixtures} fixtures passed`);
  console.log(`  validator pass rate ${pct(summary.validatorPassRate)}   repair rate ${pct(summary.repairRate)}   transient retries ${summary.transientRetries}   average rating n/a (no ratings in an eval run)`);
  console.log(`  warnings by code: ${JSON.stringify(summary.warningsByCode)}`);
  console.log(`  errors by code:   ${JSON.stringify(summary.errorsByCode)}`);
  console.log(`  hard gates: ${Object.entries(summary.gates).map(([k, v]) => `${k}=${v ? 'PASS' : 'FAIL'}`).join('  ')}`);
  console.log(`  attack suite: ${summary.attacks.blocked}/${summary.attacks.total} blocked (block rate ${pct(summary.attacks.blockRate)})`);
  console.log(`  real-traffic sample: ${traffic.samples === 0 ? `no samples in ${TRAFFIC_DIR} (false-positive rate not measured)` : `${traffic.falsePositives}/${traffic.samples} blocked (false-positive rate ${pct(traffic.falsePositiveRate ?? 0)})${traffic.skipped.length ? `; ${traffic.skipped.length} skipped as not sanitized` : ''}`}`);
  console.log(`  judge (${versions.judgeModel}, prompt ${versions.prompts.judge}): mean score ${summary.judge.meanScore ?? 'n/a'} over ${summary.judge.decided} of ${summary.judge.judged} judged drafts; ${summary.judge.unknownCriteria} criteria answered "unknown"; failed criteria ${JSON.stringify(summary.judge.failedCriteria)}`);
  for (const r of results) if (!r.pass) console.log(`  FAIL ${r.id}: ${r.failedChecks.join('; ')}`);
  if (updateBaseline) {
    if (!gatesOk || summary.passed !== summary.fixtures) {
      console.log('  baseline NOT updated: a hard gate or a fixture fails');
      process.exit(1);
    }
    file.note = 'Committed eval baseline, one entry per provider key. `npm run eval` fails when a fixture that passed here fails, or a metric is worse. Update only with `npm run eval -- --update-baseline`, in the same commit as the change that justifies it.';
    file.baselines[providerKey] = current;
    writeFileSync(BASELINE_PATH, JSON.stringify(file, null, 2) + '\n');
    console.log(`  baseline updated for "${providerKey}" in ${BASELINE_PATH}`);
  } else if (!baseline) {
    console.log(`  baseline: none committed for "${providerKey}" (run with --update-baseline to create it)`);
  } else if (regressions.length) {
    console.log(`  baseline: ${regressions.length} REGRESSION(S) against ${BASELINE_PATH}`);
    for (const x of regressions) console.log(`    - ${x}`);
  } else console.log(`  baseline: no regression against ${BASELINE_PATH}`);
  console.log('  report written to eval-report.json');
  if (!gatesOk || summary.passed !== summary.fixtures || regressions.length) process.exit(1);
}

/** A false positive is a genuine script the guardrails block: rejected at intake, or flagged as a leak or secret. */
async function realTraffic(providers: ReturnType<typeof createProviders>): Promise<{ samples: number; falsePositives: number; falsePositiveRate: number | null; blocked: { file: string; reason: string }[]; skipped: string[] }> {
  const files = existsSync(TRAFFIC_DIR) ? readdirSync(TRAFFIC_DIR).filter((f) => /\.(sql|sh|ksh|bash|pls|pkb|pks)$/i.test(f)).sort() : [];
  const blocked: { file: string; reason: string }[] = [];
  const skipped: string[] = [];
  let samples = 0;
  for (const f of files) {
    const source = readFileSync(path.join(TRAFFIC_DIR, f), 'utf8');
    const lang = langOfFile(f);
    // a sample must already be sanitized; one that is not would measure the sanitizer, not false positives
    if (scanSanitized(source, lang).length || scanSecrets(source, lang).length) {
      skipped.push(f);
      continue;
    }
    samples++;
    const r = await runFixture({ id: `traffic:${f}`, kind: 'golden', title: f, source, hash: '' }, providers, {});
    if (r.status.startsWith('rejected')) blocked.push({ file: f, reason: r.status });
    else if (r.errorCodes.includes(Codes.SANITIZE_LEAK_DETECTED) || r.errorCodes.includes(Codes.SECRET_IN_OUTPUT)) blocked.push({ file: f, reason: r.errorCodes.filter((c) => c === Codes.SANITIZE_LEAK_DETECTED || c === Codes.SECRET_IN_OUTPUT).join(',') });
  }
  return { samples, falsePositives: blocked.length, falsePositiveRate: samples ? blocked.length / samples : null, blocked, skipped };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
