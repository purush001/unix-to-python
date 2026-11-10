import { getConfig } from '@/config/env';
import { redact } from './errors';
import { nowIso } from './util';
import type { LogEntry } from '@/pipeline/types';
import type { Storage } from '@/providers/types';

export interface Logger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(fields: { runId?: string | null; stage?: string | null }): Logger;
  /** Writes buffered entries to storage. Never throws. */
  flush(storage: Storage): Promise<void>;
}

/** Keys that could carry script content are dropped before anything is written. */
const FORBIDDEN_KEYS = /^(source|draft|content|script|text|sql|body|note|comment|prompt)$/i;

function clean(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (FORBIDDEN_KEYS.test(k)) continue;
    out[k] = typeof v === 'string' ? redact(v).slice(0, 500) : v;
  }
  return out;
}

/**
 * Structured JSON logs: stdout (Vercel runtime logs) plus a buffer flushed to Postgres.
 * The buffer belongs to one request. Script content is never logged.
 */
export function createLogger(base: { runId?: string | null; stage?: string | null } = {}, buffer: LogEntry[] = []): Logger {
  const write = (level: LogEntry['level'], msg: string, data: Record<string, unknown> = {}) => {
    const entry: LogEntry = { ts: nowIso(), level, runId: base.runId ?? null, stage: base.stage ?? null, msg: redact(msg), data: clean(data) };
    buffer.push(entry);
    if (getConfig('NODE_ENV') !== 'test' || getConfig('LOG_TO_STDOUT') === '1') {
      const line = JSON.stringify({ timestamp: entry.ts, level, runId: entry.runId, stage: entry.stage, msg: entry.msg, ...entry.data });
      (level === 'error' ? console.error : console.log)(line);
    }
  };
  return {
    info: (m, d) => write('info', m, d),
    warn: (m, d) => write('warn', m, d),
    error: (m, d) => write('error', m, d),
    child: (fields) => createLogger({ ...base, ...fields }, buffer),
    async flush(storage) {
      const entries = buffer.splice(0);
      if (!entries.length) return;
      try {
        await storage.appendLogs(entries);
      } catch (e) {
        console.error(JSON.stringify({ timestamp: nowIso(), level: 'error', msg: 'log flush failed', error: redact(e instanceof Error ? e.message : String(e)) }));
      }
    },
  };
}
