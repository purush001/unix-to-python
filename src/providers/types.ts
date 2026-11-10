import type { ConversionExample, Feedback, LogEntry, Platform, RunRecord, SkillRule } from '@/pipeline/types';

// ---- LLM -------------------------------------------------------------------
export type LlmTaskKind = 'generate' | 'repair' | 'review' | 'derive-rule' | 'judge';
export interface LlmRequest {
  /** Stable text: sent first and marked for prompt caching. */
  system: string;
  user: string;
  timeoutMs: number;
  maxTokens: number;
  /** Overrides LLM_MODEL (the judge pins its own model). */
  model?: string;
  /** Structured copy of the task. Real providers ignore it; the mock works from it. */
  task: { kind: LlmTaskKind; platform: Platform; payload: Record<string, unknown> };
}
export interface LlmResponse {
  text: string;
  status: number;
  model: string;
  usage?: LlmUsage;
  stopReason?: string;
  /** How many times a paused turn was resumed. */
  continuations?: number;
}
export interface LlmUsage {
  /** Uncached input tokens. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}
export interface LlmProvider {
  readonly name: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

// ---- GitHub ----------------------------------------------------------------
export interface CommitRequest {
  branch: string;
  message: string;
  files: { path: string; content: string }[];
}
export interface CommitResult {
  sha: string;
  url: string;
  branch: string;
}
export interface GitHubProvider {
  readonly name: string;
  commitFiles(req: CommitRequest): Promise<CommitResult>;
}

// ---- SMTP ------------------------------------------------------------------
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}
export interface SmtpProvider {
  readonly name: string;
  send(msg: MailMessage): Promise<void>;
}

// ---- Storage ---------------------------------------------------------------
export interface RuleFilter {
  platform?: Platform;
  status?: SkillRule['status'];
  unindexedOnly?: boolean;
}
export interface Storage {
  readonly name: string;
  createRun(run: RunRecord): Promise<void>;
  saveRun(run: RunRecord): Promise<void>;
  getRun(id: string): Promise<RunRecord | null>;
  listRuns(limit: number): Promise<RunRecord[]>;
  /** Deletes a run and its feedback. Returns false when there was no such run. */
  deleteRun(id: string): Promise<boolean>;
  addFeedback(fb: Feedback): Promise<void>;
  listFeedback(limit: number): Promise<Feedback[]>;
  appendLogs(entries: LogEntry[]): Promise<void>;
  listLogs(limit: number): Promise<LogEntry[]>;
  deleteLogsBefore(isoTs: string): Promise<number>;
  upsertRule(rule: SkillRule): Promise<void>;
  getRule(id: string): Promise<SkillRule | null>;
  listRules(filter?: RuleFilter): Promise<SkillRule[]>;
  upsertExample(ex: ConversionExample): Promise<void>;
  listExamples(filter?: { platform?: Platform; unindexedOnly?: boolean }): Promise<ConversionExample[]>;
  /** Fixed-window counter shared by every function instance. */
  rateLimitHit(key: string, windowSeconds: number, limit: number): Promise<{ allowed: boolean; remaining: number }>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

// ---- Embeddings + vector memory ---------------------------------------------
export interface EmbeddingsProvider {
  readonly name: string;
  readonly model: string;
  embed(texts: string[], kind: 'document' | 'query'): Promise<number[][]>;
}

export type MemoryCollection = 'skill_rules' | 'conversion_examples';
export interface MemoryRecord {
  id: string;
  document: string;
  embedding: number[];
  metadata: { platform: Platform; status: string; refId: string; version: number; tags: string; embeddingModel: string };
}
export interface MemoryHit {
  id: string;
  document: string;
  metadata: MemoryRecord['metadata'];
  distance: number;
}
export interface VectorMemory {
  readonly name: string;
  upsert(collection: MemoryCollection, records: MemoryRecord[]): Promise<void>;
  query(collection: MemoryCollection, q: { embedding: number[]; platform: Platform; status: string; topK: number }): Promise<MemoryHit[]>;
  remove(collection: MemoryCollection, ids: string[]): Promise<void>;
  reset(collection: MemoryCollection): Promise<void>;
  count(collection: MemoryCollection): Promise<number>;
  ping(): Promise<boolean>;
}

export interface Providers {
  llm: LlmProvider;
  github: GitHubProvider;
  smtp: SmtpProvider;
  storage: Storage;
  memory: VectorMemory;
  embeddings: EmbeddingsProvider;
}
