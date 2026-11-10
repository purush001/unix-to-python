import { SanitizerLeakError, scanSanitized, scanSecrets, type Lang, type ScanHit } from '@/sanitizer';
import type { Storage } from '../types';

function strings(v: unknown, out: [string, string][], path = ''): void {
  if (typeof v === 'string') {
    if (v.length > 3) out.push([path, v]);
  } else if (Array.isArray(v)) v.forEach((x, i) => strings(x, out, `${path}[${i}]`));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) strings(x, out, path ? `${path}.${k}` : k);
}

const LANGS: Lang[] = ['text', 'python', 'sql', 'shell', 'ini'];

/**
 * Scans every string in a value on its own (each is a separate text). A string is a hit
 * only when it is unclean under every language reading, because the stored record mixes
 * shell, SQL, Python and prose and the field type is not known here. Aborts the write
 * on any hit (section 16).
 */
export function assertValueClean(value: unknown, where: string): void {
  const all: [string, string][] = [];
  strings(value, all);
  const seen = new Set<string>();
  for (const [path, s] of all) {
    if (seen.has(s)) continue;
    seen.add(s);
    let hits: ScanHit[] = [];
    for (const lang of LANGS) {
      hits = [...scanSanitized(s, lang), ...scanSecrets(s, lang)];
      if (hits.length === 0) break;
    }
    if (hits.length) throw new SanitizerLeakError(`${where}:${path}`, hits); // the field path, never its content
  }
}

/** Wraps a Storage so nothing unsanitized can be written to it. */
export function guardStorage(inner: Storage): Storage {
  return {
    ...inner,
    name: inner.name,
    createRun: async (run) => {
      assertValueClean(run, 'storage.runs');
      return inner.createRun(run);
    },
    saveRun: async (run) => {
      assertValueClean(run, 'storage.runs');
      return inner.saveRun(run);
    },
    addFeedback: async (fb) => {
      assertValueClean(fb, 'storage.feedback');
      return inner.addFeedback(fb);
    },
    appendLogs: async (entries) => {
      assertValueClean(entries, 'storage.logs');
      return inner.appendLogs(entries);
    },
    upsertRule: async (rule) => {
      assertValueClean(rule, 'storage.rules');
      return inner.upsertRule(rule);
    },
    upsertExample: async (ex) => {
      assertValueClean(ex, 'storage.examples');
      return inner.upsertExample(ex);
    },
  };
}
