import { CloudClient } from 'chromadb';
import { getConfig, requireSecret } from '@/config/env';
import type { MemoryCollection, MemoryHit, MemoryRecord, VectorMemory } from '../types';

const BATCH = 100; // well under Chroma Cloud's per-write quota
const MAX_DOC_BYTES = 15000; // Chroma Cloud document quota is 16 KB

/**
 * Chroma Cloud. A client is created per call and never kept at module scope.
 * Embeddings are always supplied by the caller, so collections are created
 * with embeddingFunction: null (no default embedder is loaded).
 */
export function createChromaMemory(): VectorMemory {
  const client = () =>
    new CloudClient({
      apiKey: requireSecret('CHROMA_API_KEY'),
      tenant: getConfig('CHROMA_TENANT') || undefined,
      database: getConfig('CHROMA_DATABASE') || undefined,
    });
  const coll = (c: MemoryCollection) => client().getOrCreateCollection({ name: c, embeddingFunction: null });
  return {
    name: 'chroma',
    async upsert(c, records) {
      const col = await coll(c);
      for (let i = 0; i < records.length; i += BATCH) {
        const b = records.slice(i, i + BATCH);
        await col.upsert({
          ids: b.map((r) => r.id),
          documents: b.map((r) => r.document.slice(0, MAX_DOC_BYTES)),
          embeddings: b.map((r) => r.embedding),
          metadatas: b.map((r) => ({ ...r.metadata })),
        });
      }
    },
    async query(c, q): Promise<MemoryHit[]> {
      const col = await coll(c);
      const res = await col.query({
        queryEmbeddings: [q.embedding],
        nResults: q.topK,
        where: { $and: [{ platform: q.platform }, { status: q.status }] },
        include: ['documents', 'metadatas', 'distances'],
      });
      const ids = res.ids[0] ?? [];
      return ids.map((id, i) => ({
        id,
        document: res.documents[0]?.[i] ?? '',
        metadata: (res.metadatas[0]?.[i] ?? {}) as unknown as MemoryRecord['metadata'],
        distance: res.distances[0]?.[i] ?? 1,
      }));
    },
    async remove(c, ids) {
      if (ids.length === 0) return;
      await (await coll(c)).delete({ ids });
    },
    async reset(c) {
      try {
        await client().deleteCollection({ name: c });
      } catch {
        /* collection did not exist */
      }
      await coll(c);
    },
    async count(c) {
      return (await coll(c)).count();
    },
    async ping() {
      await client().heartbeat();
      return true;
    },
  };
}
