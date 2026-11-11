import postgres from 'postgres';
import { requireSecret } from '@/config/env';
import type { ConversionExample, Feedback, LogEntry, RunRecord, SkillRule } from '@/pipeline/types';
import type { Storage } from '../types';

/**
 * Supabase Postgres through the pooled (transaction mode) connection string.
 * prepare:false is required by the transaction pooler. One small connection per
 * request, closed by close() before the function returns.
 */
export function createSupabaseStorage(): Storage {
  const url = requireSecret('POSTGRES_URL');
  // hosted Postgres requires TLS; a local database (development, tests) does not offer it
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const sql = postgres(url, { prepare: false, max: 1, idle_timeout: 5, connect_timeout: 10, onnotice: () => {}, ...(local ? {} : { ssl: 'require' as const }) });
  const j = (v: unknown) => sql.json(v as never);
  return {
    name: 'supabase',
    async createRun(run) {
      await sql`insert into runs (id, state, script_type, platform, created_at, updated_at, data)
                values (${run.id}, ${run.state}, ${run.scriptType}, ${run.platform}, ${run.createdAt}, ${run.updatedAt}, ${j(run)})`;
    },
    async saveRun(run) {
      await sql`update runs set state = ${run.state}, script_type = ${run.scriptType}, platform = ${run.platform},
                updated_at = ${run.updatedAt}, data = ${j(run)} where id = ${run.id}`;
    },
    async getRun(id) {
      const rows = await sql<{ data: RunRecord }[]>`select data from runs where id = ${id}`;
      return rows[0]?.data ?? null;
    },
    async deleteRun(id) {
      // feedback rows go with it (on delete cascade)
      const res = await sql`delete from runs where id = ${id}`;
      return res.count > 0;
    },
    async listRuns(limit) {
      const rows = await sql<{ data: RunRecord }[]>`select data from runs order by created_at desc limit ${limit}`;
      return rows.map((r) => r.data);
    },
    async addFeedback(fb) {
      await sql`insert into feedback (id, run_id, rating, comment, error_code, line, at)
                values (${fb.id}, ${fb.runId}, ${fb.rating}, ${fb.comment}, ${fb.errorCode}, ${fb.line}, ${fb.at})`;
    },
    async listFeedback(limit) {
      const rows = await sql<{ id: string; run_id: string; rating: number | null; comment: string | null; error_code: string | null; line: number | null; at: Date }[]>`
        select id, run_id, rating, comment, error_code, line, at from feedback order by at desc limit ${limit}`;
      return rows.map((r) => ({ id: r.id, runId: r.run_id, rating: r.rating, comment: r.comment, errorCode: r.error_code as Feedback['errorCode'], line: r.line, at: r.at.toISOString() }));
    },
    async appendLogs(entries) {
      if (entries.length === 0) return;
      const rows = entries.map((e) => ({ ts: e.ts, level: e.level, run_id: e.runId, stage: e.stage, msg: e.msg, data: JSON.stringify(e.data) }));
      await sql`insert into app_logs (ts, level, run_id, stage, msg, data)
                select ts::timestamptz, level, run_id, stage, msg, data::jsonb
                from jsonb_to_recordset(${j(rows)}) as t(ts text, level text, run_id text, stage text, msg text, data text)`;
    },
    async listLogs(limit) {
      const rows = await sql<{ ts: Date; level: LogEntry['level']; run_id: string | null; stage: string | null; msg: string; data: Record<string, unknown> }[]>`
        select ts, level, run_id, stage, msg, data from app_logs order by ts desc limit ${limit}`;
      return rows.reverse().map((r) => ({ ts: r.ts.toISOString(), level: r.level, runId: r.run_id, stage: r.stage, msg: r.msg, data: r.data }));
    },
    async deleteLogsBefore(isoTs) {
      const res = await sql`delete from app_logs where ts < ${isoTs}`;
      return res.count;
    },
    async upsertRule(rule) {
      await sql`insert into skill_rules (id, platform, status, version, indexed, updated_at, data)
                values (${rule.id}, ${rule.platform}, ${rule.status}, ${rule.version}, ${rule.indexed ?? false}, now(), ${j(rule)})
                on conflict (id) do update set platform = excluded.platform, status = excluded.status, version = excluded.version,
                  indexed = excluded.indexed, updated_at = now(), data = excluded.data`;
    },
    async getRule(id) {
      const rows = await sql<{ data: SkillRule }[]>`select data from skill_rules where id = ${id}`;
      return rows[0]?.data ?? null;
    },
    async listRules(filter = {}) {
      const rows = await sql<{ data: SkillRule }[]>`
        select data from skill_rules
        where (${filter.platform ?? null}::text is null or platform = ${filter.platform ?? null})
          and (${filter.status ?? null}::text is null or status = ${filter.status ?? null})
          and (${filter.unindexedOnly ?? false} = false or indexed = false)
        order by id`;
      return rows.map((r) => r.data);
    },
    async upsertExample(ex) {
      await sql`insert into conversion_examples (run_id, platform, indexed, created_at, data)
                values (${ex.runId}, ${ex.platform}, ${ex.indexed}, ${ex.createdAt}, ${j(ex)})
                on conflict (run_id) do update set platform = excluded.platform, indexed = excluded.indexed, data = excluded.data`;
    },
    async listExamples(filter = {}) {
      const rows = await sql<{ data: ConversionExample }[]>`
        select data from conversion_examples
        where (${filter.platform ?? null}::text is null or platform = ${filter.platform ?? null})
          and (${filter.unindexedOnly ?? false} = false or indexed = false)
        order by run_id`;
      return rows.map((r) => r.data);
    },
    async rateLimitHit(key, windowSeconds, limit) {
      const rows = await sql<{ count: number }[]>`
        insert into rate_limits (key, window_start, count)
        values (${key}, to_timestamp(floor(extract(epoch from now()) / ${windowSeconds}) * ${windowSeconds}), 1)
        on conflict (key, window_start) do update set count = rate_limits.count + 1
        returning count`;
      const n = rows[0]?.count ?? 1;
      if (Math.random() < 0.02) await sql`delete from rate_limits where window_start < now() - interval '1 hour'`;
      return { allowed: n <= limit, remaining: Math.max(0, limit - n) };
    },
    async ping() {
      await sql`select 1`;
      return true;
    },
    async close() {
      await sql.end({ timeout: 2 });
    },
  };
}
