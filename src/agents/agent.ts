import type { PlatformAdapter } from '@/adapters/types';
import { getConfigInt } from '@/config/env';
import { ProviderError } from '@/lib/errors';
import type { Issue } from '@/pipeline/issue-codes';
import type { GuidanceItem } from '@/pipeline/types';
import type { LlmProvider, LlmResponse } from '@/providers/types';
import { parseAgentOutput, parseReviewOutput, type AgentOutput } from './format';
import { promptVersion, REVIEWER_SYSTEM } from './prompts';

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
export const REVIEWER_ROLE = 'reviewer';

/** Parses a reply; when it is unusable, the error keeps the response so its tokens are still traced. */
function parsed<T>(response: LlmResponse, parse: (text: string) => T): AgentCall<T> {
  try {
    return { output: parse(response.text), response };
  } catch (e) {
    if (e instanceof ProviderError) e.response = response;
    throw e;
  }
}

/**
 * One model call for one unit. Agents never call each other: the orchestrator and the
 * pipeline engine decide what runs. Malformed output raises a transient ProviderError.
 */
export function makeAgent(adapter: PlatformAdapter) {
  return {
    name: adapter.agentName,
    promptVersion: () => promptVersion(adapter.systemPrompt()),
    async generate(llm: LlmProvider, input: AgentInput, timeoutMs: number): Promise<AgentCall<AgentOutput>> {
      const response = await llm.complete({
        system: adapter.systemPrompt(),
        user: adapter.generatePrompt(input),
        timeoutMs,
        maxTokens: getConfigInt('LLM_MAX_TOKENS'),
        task: { kind: 'generate', platform: adapter.platform, payload: { source: input.source, embedded: input.embedded, generateConfig: input.generateConfig, note: input.note, tags: input.tags } },
      });
      return parsed(response, parseAgentOutput);
    },
    async repair(llm: LlmProvider, input: AgentInput & { draft: string; issues: Issue[] }, timeoutMs: number): Promise<AgentCall<AgentOutput>> {
      const response = await llm.complete({
        system: adapter.systemPrompt(),
        user: adapter.repairPrompt(input),
        timeoutMs,
        maxTokens: getConfigInt('LLM_MAX_TOKENS'),
        task: { kind: 'repair', platform: adapter.platform, payload: { source: input.source, draft: input.draft, codes: input.issues.map((i) => i.code), embedded: input.embedded, generateConfig: input.generateConfig, note: input.note, tags: input.tags } },
      });
      return parsed(response, parseAgentOutput);
    },
  };
}

export const reviewerPromptVersion = () => promptVersion(REVIEWER_SYSTEM);

/** The reviewer has its own system prompt and can only report issues, never edit. */
export async function review(adapter: PlatformAdapter, llm: LlmProvider, input: { source: string; draft: string }, timeoutMs: number): Promise<AgentCall<Issue[]>> {
  const response = await llm.complete({
    system: REVIEWER_SYSTEM,
    user: adapter.reviewPrompt(input),
    timeoutMs,
    maxTokens: getConfigInt('LLM_REVIEW_MAX_TOKENS'),
    task: { kind: 'review', platform: adapter.platform, payload: { source: input.source, draft: input.draft } },
  });
  return parsed(response, parseReviewOutput);
}
