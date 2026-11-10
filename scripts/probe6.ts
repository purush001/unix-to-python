import { BASE_RULES } from '@skills/base';
import { ruleDocument } from '@/learning/memory';
import { scanSanitized, scanSecrets } from '@/sanitizer';
for (const r of BASE_RULES) { const d = ruleDocument(r); const h = [...scanSanitized(d, 'text', []), ...scanSecrets(d, 'text')]; if (h.length) console.log(r.id, h, d.split('\n').filter((_, i) => h.some((x) => x.line === i + 1))); }
