import { renderAgentOutput } from '@/agents/format';
import { continueRun, intake } from '@/agents/orchestrator';
import { ProviderError } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import type { RunRecord } from '@/pipeline/types';
import { createProviders } from '@/providers';
import { createMockLlm } from '@/providers/llm/mock';
import { createMockStorage, resetMockDb } from '@/providers/storage/mock';
import type { LlmProvider, LlmRequest, LlmResponse, Providers } from '@/providers/types';

export type Script = (req: LlmRequest, callIndex: number) => string | Error | Promise<string | Error>;

/** A provider whose replies are scripted per call. Unscripted calls fall through to the mock. */
export function scriptedLlm(script: Script): LlmProvider & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  const mock = createMockLlm();
  return {
    name: 'scripted',
    calls,
    async complete(req: LlmRequest): Promise<LlmResponse> {
      calls.push(req);
      const r = await script(req, calls.length - 1);
      if (r instanceof Error) throw r;
      if (r === '__mock__') return mock.complete(req);
      return { text: r, status: 200, model: 'scripted' };
    },
  };
}
export const MOCK = '__mock__';
export const http = (status: number) => new ProviderError('llm', 'http', status, `HTTP ${status}`);
export const reply = (converted: string) => renderAgentOutput({ converted, changes: [], suggestions: [], config: null, requirements: null });

export function testProviders(overrides: Partial<Providers> = {}): Providers {
  return createProviders({ storage: createMockStorage(), ...overrides });
}
export function freshDb(): void {
  resetMockDb();
  const g = globalThis as Record<string, unknown>;
  g.__mockGit = undefined;
  g.__mockOutbox = undefined;
}

export async function convert(source: string, providers: Providers, opts: { maxRepairAttempts?: number; persist?: boolean } = {}): Promise<RunRecord> {
  const deps = { providers, log: createLogger() };
  const limits = { budgetMs: 60000, retryBaseMs: 0, persist: opts.persist ?? false };
  const run = await intake(source, 'auto', { generateConfig: false, maxRepairAttempts: opts.maxRepairAttempts }, deps, limits);
  return continueRun(run, deps, limits);
}

export const SIMPLE_PLSQL = `SET SERVEROUTPUT ON
SPOOL run.log
BEGIN
  UPDATE PS_NW_TMP SET FLAG = 'Y' WHERE PROCESS_INSTANCE = 7;
END;
/
SPOOL OFF
`;
