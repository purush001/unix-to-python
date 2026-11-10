import { readFileSync } from 'node:fs';
import { Ctx } from '@/sanitizer/context';
import { hostPass } from '@/sanitizer/hosts';
import { namePass } from '@/sanitizer/names';
import { personalPass } from '@/sanitizer/personal';
import { secretPass } from '@/sanitizer/secrets';
const lang = (process.argv[3] ?? 'python') as 'python';
const t = readFileSync(process.argv[2], 'utf8');
const c = new Ctx();
const stages: [string, (s: string) => string][] = [['secret', (s) => secretPass(s, c, lang)], ['host', (s) => hostPass(s, c, lang)], ['name', (s) => namePass(s, c, lang, [])], ['personal', (s) => personalPass(s, c, lang)]];
let cur = t;
for (const [n, f] of stages) { const nx = f(cur); const A = cur.split('\n'), B = nx.split('\n'); A.forEach((l, i) => { if (l !== B[i]) console.log(n, i + 1, '\n   ', l.trim().slice(0, 150), '\n   ', (B[i] ?? '').trim().slice(0, 150)); }); cur = nx; }
