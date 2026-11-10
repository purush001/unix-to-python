import { createProviders } from '@/providers';
import { createMockEmbeddings } from '@/providers/embeddings/mock';
import { createMockGitHub } from '@/providers/github/mock';
import { createMockMemory } from '@/providers/memory/mock';
import { createMockSmtp } from '@/providers/smtp/mock';
import { createMockStorage } from '@/providers/storage/mock';
import { replayDir } from '@/lib/replay';

/**
 * npm run replay <conversion directory>
 * Replays a committed conversion from its stored sanitized input and compares it with
 * witness.json. Storage, GitHub, memory and mail are always mocks; the model is the mock
 * unless LLM_PROVIDER=anthropic is set on purpose. Exit code 0: identical, 2: differs.
 */
async function main(): Promise<void> {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: npm run replay <conversion directory>');
    process.exit(1);
  }
  const providers = createProviders({ storage: createMockStorage(), github: createMockGitHub(), smtp: createMockSmtp(), memory: createMockMemory(), embeddings: createMockEmbeddings() });
  const r = await replayDir(dir, providers);
  console.log(`\nReplay of ${r.runId} with the "${providers.llm.name}" model provider (${r.now.llmCalls} model calls)`);
  console.log(`  then: models [${r.then.models.join(', ') || 'not recorded'}], prompts ${JSON.stringify(r.then.promptVersions)}, final codes [${r.then.finalCodes.join(', ')}]`);
  console.log(`  now:  models [${r.now.models.join(', ')}], prompts ${JSON.stringify(r.now.promptVersions)}, final codes [${r.now.finalCodes.join(', ')}]`);
  if (r.identical && r.differences.length === 0) console.log('  result: IDENTICAL to the committed conversion');
  else {
    console.log(`  result: ${r.identical ? 'same output, different conditions' : 'DIFFERENT output'}`);
    for (const d of r.differences) console.log(`    - ${d}`);
  }
  process.exit(r.identical ? 0 : 2);
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
