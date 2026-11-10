import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getConfig } from '@/config/env';
import { createProviders } from '@/providers';
import { createMockEmbeddings } from '@/providers/embeddings/mock';
import { createMockGitHub } from '@/providers/github/mock';
import { createMockLlm } from '@/providers/llm/mock';
import { createMockMemory } from '@/providers/memory/mock';
import { createMockSmtp } from '@/providers/smtp/mock';
import { createMockStorage } from '@/providers/storage/mock';
import { loadFixtures, runFixture, summarize } from './suite';

/** `npm run eval` — mocks by default; EVAL_REAL_PROVIDER=1 uses the configured LLM (never part of `npm test`). */
async function main(): Promise<void> {
  const real = getConfig('EVAL_REAL_PROVIDER') === '1';
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
  const results = [];
  const pyCompile: Record<string, boolean | null> = {};
  for (const fx of loadFixtures()) {
    const r = await runFixture(fx, providers, { keepOutputs: true });
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
    results.push({ ...r, outputs: undefined });
  }
  rmSync(tmp, { recursive: true, force: true });
  const summary = summarize(results as never);
  const gatesOk = Object.values(summary.gates).every(Boolean);
  const report = { generatedAt: new Date().toISOString(), provider: real ? 'configured' : 'mock', pythonInterpreter: python ? 'python3 -m py_compile' : 'not available', averageRating: null, summary, pyCompile, results };
  writeFileSync('eval-report.json', JSON.stringify(report, null, 2) + '\n');
  console.log(`\nEval (${report.provider} provider): ${summary.passed}/${summary.fixtures} fixtures passed`);
  console.log(`  validator pass rate ${(summary.validatorPassRate * 100).toFixed(0)}%   repair rate ${(summary.repairRate * 100).toFixed(0)}%   transient retries ${summary.transientRetries}   average rating n/a (no ratings in an eval run)`);
  console.log(`  warnings by code: ${JSON.stringify(summary.warningsByCode)}`);
  console.log(`  errors by code:   ${JSON.stringify(summary.errorsByCode)}`);
  console.log(`  hard gates: ${Object.entries(summary.gates).map(([k, v]) => `${k}=${v ? 'PASS' : 'FAIL'}`).join('  ')}`);
  for (const r of results) if (!r.pass) console.log(`  FAIL ${r.id}: ${r.failedChecks.join('; ')}`);
  console.log('  report written to eval-report.json');
  if (!gatesOk || summary.passed !== summary.fixtures) process.exit(1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
