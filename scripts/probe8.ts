import { readFileSync } from 'node:fs';
import { beginRevision, continueRun, intake } from '@/agents/orchestrator';
import { commitFiles } from '@/lib/approval';
import { createLogger } from '@/lib/logger';
import { createProviders } from '@/providers';
import { langOfFile, scanSanitized, scanSecrets } from '@/sanitizer';
(async () => {
  const deps = { providers: createProviders(), log: createLogger() };
  const run = await intake(readFileSync(process.argv[2], 'utf8'), 'auto', { generateConfig: true }, deps, { budgetMs: 60000 });
  await continueRun(run, deps, { budgetMs: 60000 });
  if (process.argv[3]) { beginRevision(run, 'Please keep the report name; ask jsmith@corp.com'); await continueRun(run, deps, { budgetMs: 60000 }); }
  run.final = { version: run.drafts.length, approvedAt: new Date().toISOString() };
  for (const f of commitFiles(run)) { const l = langOfFile(f.path); const h = [...scanSanitized(f.content, l), ...scanSecrets(f.content, l)]; console.log(f.path.split('/').pop(), l, h.length, f.content.split('\n').filter((_, i) => h.some((x) => x.line === i + 1)).slice(0, 4).map((x) => x.slice(0, 200))); }
})();
