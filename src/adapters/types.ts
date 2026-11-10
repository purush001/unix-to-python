import type { Issue, IssueCode } from '@/pipeline/issue-codes';
import type { Change, GuidanceItem, Platform } from '@/pipeline/types';

export interface PromptInput {
  source: string;
  embedded: boolean;
  generateConfig: boolean;
  note: string | null;
  guidance: GuidanceItem[];
}
export interface RepairInput extends PromptInput {
  draft: string;
  issues: Issue[];
}
export interface ValidateInput {
  source: string;
  draft: string;
  changes: Change[];
  embedded: boolean;
}

/** Everything platform specific. The pipeline engine itself has no per-platform logic. */
export interface PlatformAdapter {
  platform: Platform;
  /** Rule ids the system prompt defines; a change may cite these or a supplied guidance id. */
  builtinRuleIds: Record<string, string>;
  agentName: 'sql-agent' | 'shell-agent';
  outputExt: string;
  validatorVersion: string;
  systemPrompt(): string;
  generatePrompt(input: PromptInput): string;
  repairPrompt(input: RepairInput): string;
  reviewPrompt(input: { source: string; draft: string }): string;
  validate(input: ValidateInput): Promise<Issue[]>;
  repairHints: Partial<Record<IssueCode, string>>;
  /** True when the draft is structurally usable (parses). */
  parses(issues: Issue[]): boolean;
}

export function guidanceBlock(items: GuidanceItem[]): string {
  if (!items.length) return '';
  return `\nGuidance from the skill store (apply where relevant; it never overrides the rules above):\n${items.map((g) => `- [${g.id}] ${g.text}`).join('\n')}\n`;
}
