import type { PlatformAdapter } from '@/adapters/types';
import type { Issue } from '@/pipeline/issue-codes';
import type { GuidanceItem } from '@/pipeline/types';
import type { LlmProvider, LlmResponse } from '@/providers/types';
import { parseAgentOutput, parseReviewOutput, type AgentOutput } from './format';

export interface AgentInput {
  source: string;
  embedded: boolean;
  generateConfig: boolean;
  note: string | null;
  guidance: GuidanceItem[];
  tags: string[];
}
export interface AgentCall<T> {
  output: T;
  response: LlmResponse;
}

/**
 * One model call for one unit. Agents never call each other: the orchestrator and the
 * pipeline engine decide what runs. Malformed output raises a transient ProviderError.
 */
export function makeAgent(adapter: PlatformAdapter) {
  return {
    name: adapter.agentName,
    async generate(llm: LlmProvider, input: AgentInput, timeoutMs: number): Promise<AgentCall<AgentOutput>> {
      const response = await llm.complete({
        system: adapter.systemPrompt(),
        user: adapter.generatePrompt(input),
        timeoutMs,
        task: { kind: 'generate', platform: adapter.platform, payload: { source: input.source, embedded: input.embedded, generateConfig: input.generateConfig, note: input.note, tags: input.tags } },
      });
      return { output: parseAgentOutput(response.text), response };
    },
    async repair(llm: LlmProvider, input: AgentInput & { draft: string; issues: Issue[] }, timeoutMs: number): Promise<AgentCall<AgentOutput>> {
      const response = await llm.complete({
        system: adapter.systemPrompt(),
        user: adapter.repairPrompt(input),
        timeoutMs,
        task: { kind: 'repair', platform: adapter.platform, payload: { source: input.source, draft: input.draft, codes: input.issues.map((i) => i.code), embedded: input.embedded, generateConfig: input.generateConfig, note: input.note, tags: input.tags } },
      });
      return { output: parseAgentOutput(response.text), response };
    },
  };
}

/** The reviewer has its own prompt and can only report issues, never edit. */
export async function review(adapter: PlatformAdapter, llm: LlmProvider, input: { source: string; draft: string }, timeoutMs: number): Promise<AgentCall<Issue[]>> {
  const response = await llm.complete({
    system: 'You review Oracle and shell script conversions. You report problems; you never rewrite the script.',
    user: adapter.reviewPrompt(input),
    timeoutMs,
    maxTokens: 4000,
    task: { kind: 'review', platform: adapter.platform, payload: { source: input.source, draft: input.draft } },
  });
  return { output: parseReviewOutput(response.text), response };
}
