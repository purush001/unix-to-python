import { readFileSync } from 'node:fs';
import { continueRun, intake } from '@/agents/orchestrator';
import { approveRun } from '@/lib/approval';
import { createLogger } from '@/lib/logger';
import { proposeAfterApproval } from '@/learning/loop';
import { createProviders, providerModes } from '@/providers';
/** Development smoke test of the real Postgres storage: a full run, approval, logs and rate limit. */
(async () => {
  const providers = createProviders();
  const log = createLogger();
  const deps = { providers, log };
  console.log(providerModes().storage, await providers.storage.ping());
  const run = await intake(readFileSync('evals/fixtures/hcm-payroll-extract.sh', 'utf8'), 'auto', { generateConfig: true }, deps, { budgetMs: 60000 });
  await continueRun(run, deps, { budgetMs: 60000 });
  const loaded = await providers.storage.getRun(run.id);
  console.log('stored state', loaded?.state, 'drafts', loaded?.drafts.length, 'equal', JSON.stringify(loaded) === JSON.stringify(run));
  const approved = await approveRun(loaded!, deps);
  await proposeAfterApproval(approved, deps);
  await providers.storage.addFeedback({ id: 'fb_' + run.id, runId: run.id, rating: 4, comment: null, errorCode: null, line: null, at: new Date().toISOString() });
  await log.flush(providers.storage);
  console.log('after approve', (await providers.storage.getRun(run.id))?.state, 'runs', (await providers.storage.listRuns(5)).length, 'logs', (await providers.storage.listLogs(500)).length, 'feedback', (await providers.storage.listFeedback(5))[0]?.rating, 'examples', (await providers.storage.listExamples()).length, 'rules', (await providers.storage.listRules()).length);
  const hits = [];
  for (let i = 0; i < 4; i++) hits.push((await providers.storage.rateLimitHit('smoke:' + run.id, 60, 3)).allowed);
  console.log('rate limit', hits, 'deleted old logs', await providers.storage.deleteLogsBefore('2000-01-01T00:00:00Z'));
  await providers.storage.close();
})().catch((e) => { console.error('ERR', e); process.exit(1); });
