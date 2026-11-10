import { assertClean } from '@/sanitizer';
import type { Storage } from '../types';

function strings(v: unknown, out: string[]): void {
  if (typeof v === 'string') {
    if (v.length > 3) out.push(v);
  } else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, out);
}

/** Scans every string in a value. Aborts the write on any hit (section 16). */
export function assertValueClean(value: unknown, where: string): void {
  const all: string[] = [];
  strings(value, all);
  assertClean(all.join('\n\u0000\n'), where);
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
