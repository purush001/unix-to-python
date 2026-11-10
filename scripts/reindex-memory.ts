import { reindexMemory } from '@/learning/memory';
import { createProviders, providerModes } from '@/providers';

/** npm run reindex-memory — rebuilds both Chroma collections from Supabase (the system of record). */
async function main(): Promise<void> {
  const providers = createProviders();
  try {
    console.log('Providers:', providerModes());
    const r = await reindexMemory(providers);
    console.log(`Reindexed ${r.rules} rule(s) and ${r.examples} example(s) with embedding model ${providers.embeddings.model}.`);
  } finally {
    await providers.storage.close();
  }
}
main().catch((e) => {
  console.error('Reindex failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
