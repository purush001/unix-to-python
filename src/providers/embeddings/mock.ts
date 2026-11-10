import { createHash } from 'node:crypto';
import type { EmbeddingsProvider } from '../types';

const DIM = 128;
/** Deterministic hashed bag-of-words embedding. Same text -> same unit vector. */
export function mockEmbed(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  for (const tok of text.toLowerCase().match(/[a-z_][a-z0-9_]{1,}/g) ?? []) {
    const h = createHash('md5').update(tok).digest();
    v[h[0] % DIM] += h[1] % 2 === 0 ? 1 : -1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}
export function createMockEmbeddings(): EmbeddingsProvider {
  return { name: 'mock', model: 'mock-hash-128', embed: async (texts) => texts.map(mockEmbed) };
}
