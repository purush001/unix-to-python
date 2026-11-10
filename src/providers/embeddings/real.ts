import { getConfig, requireSecret } from '@/config/env';
import { ProviderError } from '@/lib/errors';
import type { EmbeddingsProvider } from '../types';

/** Voyage AI embeddings over REST. Only sanitized text is ever passed in (callers scan first). */
export function createVoyageEmbeddings(): EmbeddingsProvider {
  const model = getConfig('EMBEDDINGS_MODEL');
  return {
    name: 'voyage',
    model,
    async embed(texts, kind) {
      if (texts.length === 0) return [];
      let res: Response;
      try {
        res = await fetch(`${getConfig('EMBEDDINGS_BASE_URL').replace(/\/$/, '')}/embeddings`, {
          method: 'POST',
          headers: { authorization: `Bearer ${requireSecret('VOYAGE_API_KEY')}`, 'content-type': 'application/json' },
          body: JSON.stringify({ input: texts, model, input_type: kind }),
          signal: AbortSignal.timeout(20000),
        });
      } catch {
        throw new ProviderError('embeddings', 'network', 502, 'Could not reach the embeddings provider');
      }
      if (!res.ok) throw new ProviderError('embeddings', 'http', res.status, `Embeddings provider returned HTTP ${res.status}`);
      const json = (await res.json()) as { data: { embedding: number[]; index: number }[] };
      return [...json.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    },
  };
}
