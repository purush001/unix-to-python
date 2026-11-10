import { BASE_RULES } from '@skills/base';
import { Codes, issue, type Issue } from '@/pipeline/issue-codes';
import type { ConversionExample, GuidanceItem, Platform, SkillRule } from '@/pipeline/types';
import type { MemoryRecord, Providers } from '@/providers/types';
import { assertClean } from '@/sanitizer';

export const TOP_RULES = 5;
export const TOP_EXAMPLES = 2;

type Deps = Pick<Providers, 'memory' | 'embeddings' | 'storage'>;

export function ruleDocument(r: SkillRule): string {
  return `Constructs: ${r.trigger.join(', ')}\n${r.guidance}\nBefore:\n${r.example.before}\nAfter:\n${r.example.after}`;
}
export function exampleDocument(e: ConversionExample): string {
  return `Constructs: ${e.tags.join(', ')}\nBefore:\n${e.before.slice(0, 5000)}\nAfter:\n${e.after.slice(0, 5000)}`;
}

async function toRecords(deps: Deps, items: { id: string; doc: string; platform: Platform; refId: string; version: number; tags: string[] }[]): Promise<MemoryRecord[]> {
  if (items.length === 0) return [];
  // Only sanitized text may reach the embedding provider or the vector store.
  for (const i of items) assertClean(i.doc, `memory:${i.id}`);
  const vectors = await deps.embeddings.embed(items.map((i) => i.doc), 'document');
  return items.map((i, k) => ({
    id: i.id,
    document: i.doc,
    embedding: vectors[k],
    metadata: { platform: i.platform, status: 'promoted', refId: i.refId, version: i.version, tags: i.tags.join(',') || 'none', embeddingModel: deps.embeddings.model },
  }));
}

export async function indexRules(deps: Deps, rules: SkillRule[]): Promise<void> {
  const usable = rules.filter((r) => r.status === 'base' || r.status === 'promoted');
  await deps.memory.upsert('skill_rules', await toRecords(deps, usable.map((r) => ({ id: r.id, doc: ruleDocument(r), platform: r.platform, refId: r.id, version: r.version, tags: r.trigger }))));
}
export async function indexExamples(deps: Deps, examples: ConversionExample[]): Promise<void> {
  await deps.memory.upsert('conversion_examples', await toRecords(deps, examples.map((e) => ({ id: `example-${e.runId}`, doc: exampleDocument(e), platform: e.platform, refId: e.runId, version: 1, tags: e.tags }))));
}

/** Rebuilds both collections from the system of record. */
export async function reindexMemory(deps: Deps): Promise<{ rules: number; examples: number }> {
  const learned = await deps.storage.listRules({ status: 'promoted' });
  const examples = await deps.storage.listExamples();
  await deps.memory.reset('skill_rules');
  await deps.memory.reset('conversion_examples');
  await indexRules(deps, [...BASE_RULES, ...learned]);
  await indexExamples(deps, examples);
  for (const r of learned) if (!r.indexed) await deps.storage.upsertRule({ ...r, indexed: true });
  for (const e of examples) if (!e.indexed) await deps.storage.upsertExample({ ...e, indexed: true });
  return { rules: BASE_RULES.length + learned.length, examples: examples.length };
}

/** Retries index writes that failed earlier. Called from the cron job only. */
export async function syncPendingMemory(deps: Deps, limit: number): Promise<{ synced: number; failed: number }> {
  let synced = 0;
  let failed = 0;
  for (const r of (await deps.storage.listRules({ unindexedOnly: true })).slice(0, limit)) {
    if (r.status === 'candidate') continue; // candidates are never indexed
    try {
      if (r.status === 'promoted') await indexRules(deps, [r]);
      else await deps.memory.remove('skill_rules', [r.id]);
      await deps.storage.upsertRule({ ...r, indexed: true });
      synced++;
    } catch {
      failed++;
    }
  }
  for (const e of (await deps.storage.listExamples({ unindexedOnly: true })).slice(0, limit)) {
    try {
      await indexExamples(deps, [e]);
      await deps.storage.upsertExample({ ...e, indexed: true });
      synced++;
    } catch {
      failed++;
    }
  }
  return { synced, failed };
}

export interface Retrieval {
  guidance: GuidanceItem[];
  rules: string[];
  examples: string[];
  warning: Issue | null;
  ms: number;
}

/**
 * Top matching rules and examples for a unit (section 14.2). If the memory cannot be
 * reached the conversion continues with the base rules and warning MEMORY_UNAVAILABLE.
 */
export async function retrieveGuidance(deps: Deps, input: { platform: Platform; tags: string[]; excerpt: string; extraRules?: SkillRule[] }): Promise<Retrieval> {
  const t0 = Date.now();
  const extra = input.extraRules ?? [];
  try {
    if ((deps.memory as { ephemeral?: boolean }).ephemeral) {
      // the in-memory mock holds nothing between requests: seed it from the system of record
      await indexRules(deps, [...BASE_RULES, ...(await deps.storage.listRules({ status: 'promoted' }))]);
      await indexExamples(deps, await deps.storage.listExamples());
    }
    assertClean(input.excerpt, 'memory:query');
    const [embedding] = await deps.embeddings.embed([`Constructs: ${input.tags.join(', ')}\n${input.excerpt}`], 'query');
    const rules = await deps.memory.query('skill_rules', { embedding, platform: input.platform, status: 'promoted', topK: TOP_RULES });
    const examples = await deps.memory.query('conversion_examples', { embedding, platform: input.platform, status: 'promoted', topK: TOP_EXAMPLES });
    // candidate rules under evaluation are passed straight to the agent; they are never indexed
    const candidates = extra.filter((r) => r.platform === input.platform && (r.trigger.length === 0 || r.trigger.some((t) => input.tags.includes(t))));
    for (const c of candidates) assertClean(ruleDocument(c), `memory:${c.id}`);
    return {
      guidance: [...candidates.map((r) => ({ id: r.id, kind: 'rule' as const, text: ruleDocument(r) })), ...rules.map((h) => ({ id: h.id, kind: 'rule' as const, text: h.document })), ...examples.map((h) => ({ id: h.id, kind: 'example' as const, text: h.document }))],
      rules: [...candidates.map((r) => r.id), ...rules.slice(0, TOP_RULES).map((h) => h.id)],
      examples: examples.slice(0, TOP_EXAMPLES).map((h) => h.id),
      warning: null,
      ms: Date.now() - t0,
    };
  } catch {
    const base = BASE_RULES.filter((r) => r.platform === input.platform && r.trigger.some((t) => input.tags.includes(t))).slice(0, TOP_RULES);
    return {
      guidance: base.map((r) => ({ id: r.id, kind: 'rule' as const, text: ruleDocument(r) })),
      rules: base.map((r) => r.id),
      examples: [],
      warning: issue(Codes.MEMORY_UNAVAILABLE, 'Skill memory could not be reached; the built-in rules were used.', null),
      ms: Date.now() - t0,
    };
  }
}
