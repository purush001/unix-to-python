import type { ConversionExample, Feedback, LogEntry, RunRecord, SkillRule } from '@/pipeline/types';
import type { Storage } from '../types';

interface MockDb {
  runs: Map<string, RunRecord>;
  feedback: Feedback[];
  logs: LogEntry[];
  rules: Map<string, SkillRule>;
  examples: Map<string, ConversionExample>;
  rate: Map<string, number>;
}
/**
 * The mock's "database". It stands in for Postgres in dev and test, so it has to
 * outlive a request; it lives on globalThis and is only reachable through the Storage
 * interface. Values are cloned on the way in and out, exactly like a real database.
 */
export function mockDb(): MockDb {
  const g = globalThis as unknown as { __mockDb?: MockDb };
  return (g.__mockDb ??= { runs: new Map(), feedback: [], logs: [], rules: new Map(), examples: new Map(), rate: new Map() });
}
export function resetMockDb(): void {
  (globalThis as unknown as { __mockDb?: MockDb }).__mockDb = undefined;
}
const clone = <T>(v: T): T => structuredClone(v);

export function createMockStorage(): Storage {
  const db = mockDb();
  return {
    name: 'mock',
    async createRun(run) {
      db.runs.set(run.id, clone(run));
    },
    async saveRun(run) {
      db.runs.set(run.id, clone(run));
    },
    async getRun(id) {
      const r = db.runs.get(id);
      return r ? clone(r) : null;
    },
    async listRuns(limit) {
      return [...db.runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map(clone);
    },
    async deleteRun(id) {
      const had = db.runs.delete(id);
      db.feedback = db.feedback.filter((f) => f.runId !== id);
      return had;
    },
    async addFeedback(fb) {
      db.feedback.push(clone(fb));
    },
    async listFeedback(limit) {
      return db.feedback.slice(-limit).reverse().map(clone);
    },
    async appendLogs(entries) {
      db.logs.push(...entries.map(clone));
    },
    async listLogs(limit) {
      return db.logs.slice(-limit).map(clone);
    },
    async deleteLogsBefore(isoTs) {
      const before = db.logs.length;
      db.logs = db.logs.filter((l) => l.ts >= isoTs);
      return before - db.logs.length;
    },
    async upsertRule(rule) {
      db.rules.set(rule.id, clone(rule));
    },
    async deleteRule(id) {
      return db.rules.delete(id);
    },
    async getRule(id) {
      const r = db.rules.get(id);
      return r ? clone(r) : null;
    },
    async listRules(filter = {}) {
      return [...db.rules.values()]
        .filter((r) => (!filter.platform || r.platform === filter.platform) && (!filter.status || r.status === filter.status) && (!filter.unindexedOnly || !r.indexed))
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(clone);
    },
    async upsertExample(ex) {
      db.examples.set(ex.runId, clone(ex));
    },
    async listExamples(filter = {}) {
      return [...db.examples.values()]
        .filter((e) => (!filter.platform || e.platform === filter.platform) && (!filter.unindexedOnly || !e.indexed))
        .sort((a, b) => a.runId.localeCompare(b.runId))
        .map(clone);
    },
    async rateLimitHit(key, windowSeconds, limit) {
      const win = Math.floor(Date.now() / 1000 / windowSeconds);
      const k = `${key}:${win}`;
      const n = (db.rate.get(k) ?? 0) + 1;
      db.rate.set(k, n);
      return { allowed: n <= limit, remaining: Math.max(0, limit - n) };
    },
    async ping() {
      return true;
    },
    async close() {},
  };
}
