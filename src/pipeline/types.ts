import type { Issue, IssueCode } from './issue-codes';

export type Platform = 'plsql' | 'shell-python';
export type ScriptType = 'sql' | 'plsql' | 'sqlplus' | 'shell' | 'mixed' | 'unsupported';
export type SelectableType = Exclude<ScriptType, 'unsupported'> | 'auto';

export type RunState =
  | 'received'
  | 'sanitized'
  | 'drafting'
  | 'draft_ready'
  | 'changes_requested'
  | 'approved'
  | 'saved'
  | 'failed';

export type StageName = 'intake' | 'generate' | 'validate' | 'repair' | 'review' | 'results';

export interface Change {
  ruleId: string;
  lines: string;
  summary: string;
  reason: string;
  risk: 'low' | 'medium' | 'high';
}

export interface Suggestion {
  title: string;
  detail: string;
}

/** The agreed "unknown" signal: a part the agent left unconverted, and what was missing. */
export interface Unknown {
  sourceLine: number | null;
  missing: string;
}

export type SpanKind = 'stage' | 'llm' | 'retrieval' | 'guardrail';
export type SpanAttr = string | number | boolean | string[] | null;
/** One span of the run's trace (the trace ID is the run ID). */
export interface Span {
  id: string;
  parentId: string | null;
  name: string;
  kind: SpanKind;
  unitId: string | null;
  startedAt: string;
  ms: number;
  status: 'ok' | 'error';
  attrs: Record<string, SpanAttr>;
}

/** A judge's structured verdict, attached to the run as a score. */
export interface JudgeScore {
  /** Share of applicable criteria answered "yes" (0 to 1); null when none was applicable. */
  score: number | null;
  criteria: { id: string; verdict: 'yes' | 'no' | 'unknown'; evidence: string }[];
  model: string;
  promptVersion: string;
  draftVersion: number;
  at: string;
}

export interface SanitizeCounts {
  emails: number;
  names: number;
  hosts: number;
  users: number;
  secrets: number;
  personal: number;
}

export interface UnitState {
  id: string;
  platform: Platform;
  kind: ScriptType;
  /** Where the unit came from in the sanitized source (1-based, inclusive). */
  origin: { startLine: number; endLine: number; embeddedIn?: string };
  source: string;
  stage: 'generate' | 'validate' | 'repair' | 'review' | 'done';
  draft: string | null;
  /** Most recent non-empty draft that parsed. */
  lastUsable: string | null;
  config: string | null;
  requirements: string | null;
  changes: Change[];
  suggestions: Suggestion[];
  unknowns?: Unknown[];
  /** Model IDs that actually answered for this unit. */
  models?: string[];
  issues: Issue[];
  /** Pipeline-level warnings (repair/memory), kept across validations. */
  notes: Issue[];
  attempts: number;
  transientRetries: number;
  reviewedDraftHash: string | null;
  repairStopped: boolean;
  /** Error codes the pending repair must fix. */
  pendingRepair: IssueCode[] | null;
  retrieved: { rules: string[]; examples: string[] };
  guidance: GuidanceItem[];
  stageCodes: Partial<Record<StageName, IssueCode[]>>[];
  firstDraft: string | null;
  reviewIssues: Issue[];
  lastReviewCodes: IssueCode[] | null;
  /** Shell units: true once embedded SQL drafts were spliced into the source. */
  composed: boolean;
}

export interface GuidanceItem {
  id: string;
  kind: 'rule' | 'example';
  text: string;
}

export interface OutputFile {
  name: string;
  kind: 'sql' | 'python' | 'config' | 'requirements' | 'runtime';
  content: string;
}

export interface ScriptResult {
  scriptId: string;
  platform: Platform;
  status: 'ok' | 'ok_with_warnings' | 'failed';
  draft: string;
  issues: Issue[];
  warnings: Issue[];
  changes: Change[];
  attempts: number;
  witness: Witness;
}

export interface Witness {
  runId: string;
  draftVersion: number;
  inputHash: string;
  outputHash: string;
  outputHashes: Record<string, string>;
  platform: Platform;
  scriptType: ScriptType;
  validatorVersions: Record<string, string>;
  /** Issue codes found at each stage, per unit, in order. */
  stageCodes: Record<string, Partial<Record<StageName, IssueCode[]>>[]>;
  finalCodes: IssueCode[];
  sanitizer: { before: SanitizeCounts; afterHits: number };
  syntax: { file: string; checker: string; ok: boolean }[];
  rulesApplied: string[];
  retrieved: { rules: string[]; examples: string[] };
  embeddingsModel: string;
  /** Model IDs that actually answered (a fallback model shows up here). */
  models: string[];
  /** Version hash of each system prompt used, by role. */
  promptVersions: Record<string, string>;
  effort: string;
  attempts: Record<string, number>;
  transientRetries: number;
  timestamps: { received: string; completed: string };
}

export interface DraftVersion {
  version: number;
  createdAt: string;
  note: string | null;
  files: OutputFile[];
  result: ScriptResult;
  suggestions: Suggestion[];
  unitResults: { unitId: string; platform: Platform; kind: ScriptType; origin: UnitState['origin']; attempts: number; codes: IssueCode[] }[];
}

export interface RunOptions {
  generateConfig: boolean;
  maxRepairAttempts: number;
}

export interface RunRecord {
  id: string;
  state: RunState;
  scriptType: ScriptType;
  platform: Platform;
  createdAt: string;
  updatedAt: string;
  options: RunOptions;
  inputHash: string;
  sanitizedSource: string;
  sanitization: { counts: SanitizeCounts; warnings: Issue[]; highlightLines: number[] };
  units: UnitState[];
  /** Note driving the current drafting pass (revise), if any. */
  pendingNote: string | null;
  drafts: DraftVersion[];
  reviewerNotes: { at: string; note: string }[];
  stageLog: { stage: StageName; unitId: string | null; at: string; ms: number }[];
  final: { version: number; approvedAt: string } | null;
  save: { status: 'pending' | 'saved' | 'failed'; commit?: { sha: string; url: string; branch: string; path: string }; error?: string } | null;
  rating: { rating: number; comment: string | null; at: string } | null;
  error: { code: string; message: string; status: number } | null;
  learned: boolean;
  /** Spans of every stage, model call, retrieval and guardrail (absent on runs stored before tracing). */
  trace?: Span[];
  /** Live or eval judge verdict for the latest judged draft. */
  judge?: JudgeScore | null;
}

export interface Feedback {
  id: string;
  runId: string;
  rating: number | null;
  comment: string | null;
  errorCode: IssueCode | null;
  line: number | null;
  at: string;
}

export interface SkillRule {
  id: string;
  version: number;
  platform: Platform;
  /** Constructs that make the rule relevant, e.g. ["cursor-loop", "commit-in-loop"]. */
  trigger: string[];
  guidance: string;
  example: { before: string; after: string };
  sourceRunId: string | null;
  evalWitness: unknown | null;
  status: 'base' | 'candidate' | 'promoted' | 'rejected' | 'disabled';
  createdAt?: string;
  updatedAt?: string;
  rejectReason?: string;
  /** False until the rule's index state matches Chroma. */
  indexed?: boolean;
  /** True once the promoted rule was mirrored to the data branch. */
  mirrored?: boolean;
}

export interface ConversionExample {
  runId: string;
  platform: Platform;
  tags: string[];
  before: string;
  after: string;
  createdAt: string;
  indexed: boolean;
}

export interface LogEntry {
  ts: string;
  level: 'info' | 'warn' | 'error';
  runId: string | null;
  stage: string | null;
  msg: string;
  data: Record<string, unknown>;
}

export interface ProgressEvent {
  type: 'stage';
  stage: StageName;
  unitId: string | null;
  status: 'start' | 'done';
  detail?: string;
}
