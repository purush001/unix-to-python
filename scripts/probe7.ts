import { readFileSync } from 'node:fs';
import { beginRevision, continueRun, intake } from '@/agents/orchestrator';
import { createLogger } from '@/lib/logger';
import { createProviders } from '@/providers';
import { scanSanitized, scanSecrets, type Lang } from '@/sanitizer';
(async () => {
  const providers = createProviders();
  const inner = providers.storage.saveRun;
  providers.storage.saveRun = async (run) => {
    try { await inner(run); } catch (e) {
      const all: string[] = [];
      const walk = (v: unknown, p: string) => { if (typeof v === 'string') { if (v.length > 3) all.push(p + '\u0001' + v); } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`)); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${p}.${k}`); };
      walk(run, 'run');
      for (const s of all) { const [p, v] = s.split('\u0001'); let bad = true; let h: { line: number }[] = []; for (const l of ['text', 'python', 'sql', 'shell', 'ini'] as Lang[]) { h = [...scanSanitized(v, l), ...scanSecrets(v, l)]; if (!h.length) { bad = false; break; } } if (bad) console.log(p, h.slice(0, 3), v.split('\n').filter((_, i) => h.some((x) => x.line === i + 1)).slice(0, 3)); }
      throw e;
    }
  };
  const deps = { providers, log: createLogger() };
  const run = await intake(readFileSync(process.argv[2], 'utf8'), 'auto', { generateConfig: true }, deps, { budgetMs: 60000 });
  await continueRun(run, deps, { budgetMs: 60000 });
  beginRevision(run, 'Please keep the report name; ask jsmith@corp.com');
  await continueRun(run, deps, { budgetMs: 60000 });
  console.log('ok', run.state);
})().catch((e) => console.log('ERR', e.message));
