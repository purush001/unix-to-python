import { getConfig } from '@/config/env';
import { createMockEmbeddings } from './embeddings/mock';
import { createVoyageEmbeddings } from './embeddings/real';
import { createMockGitHub } from './github/mock';
import { createRealGitHub } from './github/real';
import { createMockLlm } from './llm/mock';
import { createAnthropicLlm } from './llm/real';
import { createMockMemory } from './memory/mock';
import { createChromaMemory } from './memory/real';
import { createMockSmtp } from './smtp/mock';
import { createRealSmtp } from './smtp/real';
import { createMockStorage } from './storage/mock';
import { createSupabaseStorage } from './storage/real';
import { guardStorage } from './storage/guard';
import type { Providers } from './types';

export function providerModes() {
  return {
    llm: getConfig('LLM_PROVIDER') === 'anthropic' ? 'real' : 'mock',
    github: getConfig('GITHUB_PROVIDER') === 'github' ? 'real' : 'mock',
    smtp: getConfig('SMTP_PROVIDER') === 'smtp' ? 'real' : 'mock',
    storage: getConfig('STORAGE_PROVIDER') === 'supabase' ? 'real' : 'mock',
    memory: getConfig('MEMORY_PROVIDER') === 'chroma' ? 'real' : 'mock',
    embeddings: getConfig('EMBEDDINGS_PROVIDER') === 'voyage' ? 'real' : 'mock',
  } as const;
}

/**
 * Builds the providers for ONE request. Call it inside a route handler and let
 * the result go out of scope when the request ends (always `await p.storage.close()`).
 */
export function createProviders(overrides: Partial<Providers> = {}): Providers {
  const m = providerModes();
  return {
    llm: overrides.llm ?? (m.llm === 'real' ? createAnthropicLlm() : createMockLlm()),
    github: overrides.github ?? (m.github === 'real' ? createRealGitHub() : createMockGitHub()),
    smtp: overrides.smtp ?? (m.smtp === 'real' ? createRealSmtp() : createMockSmtp()),
    storage: guardStorage(overrides.storage ?? (m.storage === 'real' ? createSupabaseStorage() : createMockStorage())),
    memory: overrides.memory ?? (m.memory === 'real' ? createChromaMemory() : createMockMemory()),
    embeddings: overrides.embeddings ?? (m.embeddings === 'real' ? createVoyageEmbeddings() : createMockEmbeddings()),
  };
}
