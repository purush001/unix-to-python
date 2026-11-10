import type { MemoryCollection, MemoryHit, MemoryRecord, VectorMemory } from '../types';

function cosineDistance(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * (b[i] ?? 0);
    na += a[i] * a[i];
    nb += (b[i] ?? 0) * (b[i] ?? 0);
  }
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/** In-memory vector store. One instance per request; seeded from storage by the memory service. */
export function createMockMemory(): VectorMemory & { ephemeral: true } {
  const data: Record<MemoryCollection, Map<string, MemoryRecord>> = { skill_rules: new Map(), conversion_examples: new Map() };
  return {
    name: 'mock',
    ephemeral: true,
    async upsert(c, records) {
      for (const r of records) data[c].set(r.id, r);
    },
    async query(c, q): Promise<MemoryHit[]> {
      return [...data[c].values()]
        .filter((r) => r.metadata.platform === q.platform && r.metadata.status === q.status)
        .map((r) => ({ id: r.id, document: r.document, metadata: r.metadata, distance: cosineDistance(q.embedding, r.embedding) }))
        .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id))
        .slice(0, q.topK);
    },
    async remove(c, ids) {
      for (const id of ids) data[c].delete(id);
    },
    async reset(c) {
      data[c].clear();
    },
    async count(c) {
      return data[c].size;
    },
    async ping() {
      return true;
    },
  };
}
