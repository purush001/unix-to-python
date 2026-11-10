import { readFileSync, writeFileSync } from 'node:fs';
import { continueRun, intake } from '@/agents/orchestrator';
import { createLogger } from '@/lib/logger';
import { createProviders } from '@/providers';
(async () => {
  const providers = createProviders();
  const deps = { providers, log: createLogger() };
  const run = await intake(readFileSync(process.argv[2], 'utf8'), 'auto', { generateConfig: true }, deps, { budgetMs: 60000 });
  await continueRun(run, deps, { budgetMs: 60000, onProgress: (e) => e.status === 'done' && process.stdout.write(`[${e.stage}${e.unitId ? ':' + e.unitId : ''}] `) });
  const d = run.drafts[0];
  console.log('\n', run.scriptType, run.state, d.result.status, d.result.issues.map((i) => `${i.code}@${i.line}: ${i.message.slice(0, 90)}`));
  console.log(d.result.changes.map((c) => c.ruleId).join(', '));
  console.log(d.suggestions.map((s) => s.title));
  writeFileSync(process.argv[3], d.files[0].content);
  if (process.argv[4]) console.log(d.files[0].content);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
