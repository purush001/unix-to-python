import { readFileSync } from 'node:fs';
import { sanitize, scanSanitized, scanSecrets } from '@/sanitizer';
import { validatePython } from '@/adapters/shell-python/validators';
const src = sanitize(readFileSync(process.argv[2], 'utf8'), 'shell', []).text;
const py = readFileSync(process.argv[3], 'utf8');
validatePython({ source: src, draft: py }).then((i) => { console.log(i); console.log(scanSanitized(py, 'python', []), scanSecrets(py, 'python')); });
