import { readFileSync, writeFileSync } from 'node:fs';
import { sanitize } from '@/sanitizer';
import { mockConvertShell } from '@/providers/llm/mock-shell';
const src = sanitize(readFileSync(process.argv[2], 'utf8'), 'shell', []).text;
const r = mockConvertShell(src, { generateConfig: true });
writeFileSync(process.argv[3], r.python);
console.log(r.python.split('def job(')[1].split('def close_resources')[0]);
console.log(r.config); console.log(r.changes.map((c) => c.ruleId).join(','));
