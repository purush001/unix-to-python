import { ADAPTERS } from '@/adapters';
import { review as reviewCall, REVIEWER_ROLE, reviewerPromptVersion, type AgentCall } from '@/agents/agent';
import { RULE_REVIEWER_EDIT, RULE_REVIEWER_NOTE, RULE_UNSPECIFIED } from '@/agents/prompts';
import { getConfig, getConfigInt } from '@/config/env';
import { addLlmSpan, addSpan, newSpanId, spanClock, tokensSpent } from '@/lib/trace';
import { shellAgent } from '@/agents/shell-agent';
import { sqlAgent } from '@/agents/sql-agent';
import { costUsd } from '@/lib/cost';
import { AppError, ProviderError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import { nowIso, sha256, sleep } from '@/lib/util';
import { retrieveGuidance } from '@/learning/memory';
import type { Providers } from '@/providers/types';
import { sanitize, scanSecrets, type Lang } from '@/sanitizer';
import { detectConstructs } from './constructs';
import { ALL_CODES, Codes, errorCodes, isBlockingReview, issue, sameCodeSet, type Issue, type IssueCode } from './issue-codes';
import type { Platform, ProgressEvent, RunRecord, SkillRule, StageName, UnitState } from './types';

export interface EngineOptions {
  timeoutMs: number;
  transientRetries: number;
  retryBaseMs: number;
  /** Epoch ms after which no new stage is started in this request. */
  deadline: number;
  onProgress?: (e: ProgressEvent) => void;
  /** Called after every stage; must persist the run. */
  persist: (run: RunRecord) => Promise<void>;
  /** Candidate rules under evaluation (learning loop). */
  extraRules?: SkillRule[];
  skipMemory?: boolean;
  /** Input + output tokens one run may spend; no model call starts once it is reached. */
  maxRunTokens: number;
}
export interface EngineDeps {
  providers: Providers;
  log: Logger;
}

const AGENTS = { plsql: sqlAgent, 'shell-python': shellAgent } as const;
const LANG: Record<Platform, Lang> = { plsql: 'sql', 'shell-python': 'python' };
export const LEAK_CODES: IssueCode[] = [Codes.SANITIZE_LEAK_DETECTED, Codes.SECRET_IN_OUTPUT];

/**
 * Retries transient provider failures (malformed or empty output, 5xx, timeout, network)
 * up to `transientRetries` times with backoff and jitter. These retries never count as
 * repair attempts. Non-transient errors (for example 429) are thrown at once.
 */
export async function withTransientRetry<T>(fn: (attempt: number) => Promise<T>, unit: Pick<UnitState, 'transientRetries'>, opts: Pick<EngineOptions, 'transientRetries' | 'retryBaseMs'>, log?: Logger): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      if (!(e instanceof ProviderError) || !e.transient || attempt >= opts.transientRetries) throw e;
      unit.transientRetries++;
      log?.warn('transient provider failure, retrying', { failure: e.failure, providerStatus: e.status, retry: attempt + 1 });
      await sleep(opts.retryBaseMs * 2 ** attempt + Math.floor(Math.random() * (opts.retryBaseMs / 2 + 1)));
    }
  }
}

/**
 * Output scan. The model only ever saw sanitized text, so anything the sanitizer would
 * still replace was invented by the model. It is removed before the draft is stored or
 * shown, and reported as an error.
 */
export function scrub(text: string, lang: Lang): { text: string; issues: Issue[] } {
  const issues: Issue[] = [];
  const secretLines = scanSecrets(text, lang).map((h) => h.line);
  const clean = sanitize(text, lang);
  if (clean.text !== text) {
    const before = text.split('\n');
    const after = clean.text.split('\n');
    for (let i = 0; i < Math.max(before.length, after.length); i++) {
      if (before[i] === after[i]) continue;
      if (secretLines.includes(i + 1)) issues.push(issue(Codes.SECRET_IN_OUTPUT, 'A literal that looks like a password, token or key was removed from the output.', i + 1));
      else issues.push(issue(Codes.SANITIZE_LEAK_DETECTED, 'A host, user, email address or personal value that is not a placeholder was removed from the output.', i + 1));
    }
  }
  return { text: clean.text, issues };
}

function setDraft(unit: UnitState, platform: Platform, out: { converted: string; changes: UnitState['changes']; suggestions: UnitState['suggestions']; unknowns?: UnitState['unknowns']; config: string | null; requirements: string | null }): { stripped: number } {
  const d = scrub(out.converted, LANG[platform]);
  const c = out.config ? scrub(out.config, 'ini') : null;
  unit.draft = d.text;
  unit.config = c ? c.text : null;
  unit.requirements = out.requirements ? scrub(out.requirements, 'text').text : null;
  unit.changes = out.changes.map((ch) => ({ ...ch, summary: sanitize(ch.summary, 'text').text, reason: sanitize(ch.reason, 'text').text }));
  unit.suggestions = out.suggestions.map((s) => ({ title: sanitize(s.title, 'text').text, detail: sanitize(s.detail, 'text').text }));
  // the agreed "unknown" signal becomes a warning the reviewer sees; its text is sanitized like everything else
  unit.unknowns = (out.unknowns ?? []).map((u) => ({ sourceLine: u.sourceLine, missing: sanitize(u.missing, 'text').text }));
  const unknownNotes = unit.unknowns.map((u) => issue(Codes.CONVERT_UNKNOWN, u.missing, null, u.sourceLine ? { sourceLine: u.sourceLine } : {}));
  unit.notes = [...unit.notes.filter((n) => !LEAK_CODES.includes(n.code) && n.code !== Codes.CONVERT_UNKNOWN), ...d.issues, ...(c?.issues ?? []), ...unknownNotes];
  unit.firstDraft ??= unit.draft;
  return { stripped: d.issues.length + (c?.issues.length ?? 0) };
}

/**
 * S14. Every rule ID the change list cites must be one the model was given (retrieved
 * guidance), one the system prompt defines, or an issue code. Anything else was invented.
 */
export function unknownRuleIds(unit: Pick<UnitState, 'changes' | 'guidance' | 'platform'>): string[] {
  const allowed = new Set<string>([...unit.guidance.map((g) => g.id), ...Object.keys(ADAPTERS[unit.platform].builtinRuleIds), ...ALL_CODES, RULE_REVIEWER_NOTE, RULE_REVIEWER_EDIT, RULE_UNSPECIFIED]);
  return [...new Set(unit.changes.map((c) => c.ruleId).filter((id) => !allowed.has(id)))];
}

/** Span for the output guardrail that strips what the model invented. */
function scrubSpan(run: RunRecord, parentId: string, unit: UnitState, r: { stripped: number }): void {
  addSpan(run, { parentId, name: 'guardrail.output.scrub', kind: 'guardrail', unitId: unit.id, startedAt: nowIso(), ms: 0, status: r.stripped ? 'error' : 'ok', attrs: { 'app.guardrail.hits': r.stripped, 'app.guardrail.action': r.stripped ? 'stripped' : 'pass' } });
}

export function unitIssues(unit: UnitState): Issue[] {
  return [...unit.issues, ...unit.reviewIssues, ...unit.notes];
}

function note(unit: UnitState, code: IssueCode, message: string): void {
  if (!unit.notes.some((n) => n.code === code)) unit.notes.push(issue(code, message, null));
}

/**
 * Advances one unit through generate → validate → repair → review until it is done or the
 * request deadline is reached. State is persisted after every stage, so a later request
 * resumes at the next stage; a resumed stage is not a repair attempt.
 */
export async function advanceUnit(run: RunRecord, unit: UnitState, deps: EngineDeps, opts: EngineOptions): Promise<'done' | 'paused'> {
  const adapter = ADAPTERS[unit.platform];
  const agent = AGENTS[unit.platform];
  const { llm } = deps.providers;
  const log = deps.log.child({ runId: run.id });
  const maxRepairs = run.options.maxRepairAttempts;
  const input = () => ({ source: unit.source, embedded: !!unit.origin.embeddedIn, generateConfig: run.options.generateConfig, note: run.pendingNote, guidance: unit.guidance, tags: detectConstructs(unit.source, unit.platform) });
  const record = (stage: StageName, codes: IssueCode[]) => unit.stageCodes.push({ [stage]: codes });
  const requestModel = getConfig('LLM_MODEL');
  let stageSpanId = newSpanId();
  /** One model call with transient retries; every attempt adds a span with tokens and cost. */
  const llmCall = <T>(role: string, operation: string, promptVer: string, maxTokens: number, fn: () => Promise<AgentCall<T>>, slog: Logger): Promise<AgentCall<T>> =>
    withTransientRetry(async (attempt) => {
      const c = spanClock();
      const base = { role, operation, promptVersion: promptVer, requestModel, maxTokens, attempt: attempt + 1, parentId: stageSpanId, unitId: unit.id, startedAt: c.startedAt };
      try {
        const call = await fn();
        addLlmSpan(run, { ...base, ms: Date.now() - c.t0 }, call.response);
        if (!(unit.models ??= []).includes(call.response.model)) unit.models.push(call.response.model);
        return call;
      } catch (e) {
        addLlmSpan(run, { ...base, ms: Date.now() - c.t0 }, e);
        throw e;
      }
    }, unit, opts, slog);
  const overBudget = () => tokensSpent(run) >= opts.maxRunTokens;

  while (unit.stage !== 'done') {
    if (Date.now() >= opts.deadline) return 'paused';
    const stage = unit.stage;
    const t0 = Date.now();
    const stageStartedAt = nowIso();
    stageSpanId = newSpanId();
    const stageAttrs: Record<string, string | number | boolean | string[] | null> = {};
    opts.onProgress?.({ type: 'stage', stage, unitId: unit.id, status: 'start' });
    const slog = log.child({ stage });
    let usage: AgentCall<unknown>['response']['usage'];
    let providerStatus: number | undefined;
    let model: string | undefined;
    let promptVer: string | undefined;
    let stopReason: string | undefined;

    if (stage === 'generate') {
      if (!opts.skipMemory && unit.guidance.length === 0) {
        const rc = spanClock();
        const r = await retrieveGuidance(deps.providers, { platform: unit.platform, tags: detectConstructs(unit.source, unit.platform), excerpt: unit.source.slice(0, 1500), extraRules: opts.extraRules });
        unit.guidance = r.guidance;
        unit.retrieved = { rules: r.rules, examples: r.examples };
        if (r.warning) unit.notes.push(r.warning);
        addSpan(run, { parentId: stageSpanId, name: 'retrieval', kind: 'retrieval', unitId: unit.id, startedAt: rc.startedAt, ms: r.ms, status: r.warning ? 'error' : 'ok', attrs: { 'app.retrieved.rule_ids': r.rules, 'app.retrieved.example_ids': r.examples, 'app.retrieval.unavailable': !!r.warning, 'app.embeddings.model': deps.providers.embeddings.model } });
        slog.info('memory retrieval', { ms: r.ms, ruleHits: r.rules.length, exampleHits: r.examples.length, unavailable: !!r.warning });
      }
      // Nothing drafted yet: a provider error here is thrown so the API returns its real status.
      if (overBudget()) throw new AppError('RUN_TOKEN_BUDGET_REACHED', 'This run reached its token budget before a draft could be produced.', 422, run.id);
      promptVer = agent.promptVersion();
      const call = await llmCall(agent.name, 'generate', promptVer, getConfigInt('LLM_MAX_TOKENS'), () => agent.generate(llm, input(), opts.timeoutMs), slog);
      usage = call.response.usage;
      providerStatus = call.response.status;
      model = call.response.model;
      stopReason = call.response.stopReason;
      scrubSpan(run, stageSpanId, unit, setDraft(unit, unit.platform, call.output));
      unit.stage = 'validate';
    } else if (stage === 'validate') {
      const draft = unit.draft ?? '';
      const invented = unknownRuleIds(unit);
      unit.issues = [
        ...(await adapter.validate({ source: unit.source, draft, changes: unit.changes, embedded: !!unit.origin.embeddedIn })),
        ...invented.map((id) => issue(Codes.CHANGE_RULE_UNKNOWN, `The change list cites rule ID "${id.slice(0, 80)}", which was not supplied and is not built in.`, null)),
      ];
      stageAttrs['app.validator.version'] = adapter.validatorVersion;
      if (draft.trim() && adapter.parses(unit.issues)) unit.lastUsable = draft;
      const now = errorCodes([...unit.issues, ...unit.notes.filter((n) => LEAK_CODES.includes(n.code))]);
      record('validate', now);
      if (unit.pendingRepair) {
        // an attempt that leaves the same errors is not worth repeating
        if (sameCodeSet(unit.pendingRepair, now)) {
          note(unit, Codes.REPAIR_NO_PROGRESS, 'A repair attempt left the same set of errors; repairing stopped early.');
          unit.repairStopped = true;
        }
        unit.pendingRepair = null;
      }
      if (now.length && !unit.repairStopped && unit.attempts < maxRepairs && overBudget()) {
        note(unit, Codes.RUN_TOKEN_BUDGET_REACHED, 'The run reached its token budget, so the remaining errors were not repaired.');
        unit.repairStopped = true;
      }
      if (now.length && !unit.repairStopped && unit.attempts < maxRepairs) {
        unit.pendingRepair = now;
        unit.stage = 'repair';
      } else unit.stage = unit.reviewedDraftHash === sha256(draft) ? 'done' : 'review';
    } else if (stage === 'repair') {
      const blockingReview = unit.reviewIssues.filter((i) => isBlockingReview(i.code));
      const toFix = [...unit.issues, ...unit.notes.filter((n) => LEAK_CODES.includes(n.code)), ...blockingReview].filter((i) => i.severity === 'error');
      try {
        promptVer = agent.promptVersion();
        const call = await llmCall(agent.name, 'repair', promptVer, getConfigInt('LLM_MAX_TOKENS'), () => agent.repair(llm, { ...input(), draft: unit.draft ?? '', issues: toFix }, opts.timeoutMs), slog);
        usage = call.response.usage;
        providerStatus = call.response.status;
        model = call.response.model;
        stopReason = call.response.stopReason;
        unit.attempts++;
        scrubSpan(run, stageSpanId, unit, setDraft(unit, unit.platform, call.output));
        unit.reviewIssues = [];
      } catch (e) {
        if (!(e instanceof ProviderError)) throw e;
        providerStatus = e.status;
        // keep the most recent non-empty draft that parsed
        if (unit.lastUsable) unit.draft = unit.lastUsable;
        note(unit, Codes.REPAIR_FAILED_KEPT_DRAFT, `A repair call failed (${e.failure}${e.status ? ` ${e.status}` : ''}); the last usable draft was kept.`);
        unit.repairStopped = true;
        unit.pendingRepair = null;
      }
      unit.stage = 'validate';
    } else if (stage === 'review') {
      const draft = unit.draft ?? '';
      try {
        if (overBudget()) {
          note(unit, Codes.RUN_TOKEN_BUDGET_REACHED, 'The run reached its token budget, so the independent review was not run.');
          throw new ProviderError('llm', 'http', 429, 'The run reached its token budget before the review');
        }
        promptVer = reviewerPromptVersion();
        const call = await llmCall(REVIEWER_ROLE, 'review', promptVer, getConfigInt('LLM_REVIEW_MAX_TOKENS'), () => reviewCall(adapter, llm, { source: unit.source, draft }, opts.timeoutMs), slog);
        usage = call.response.usage;
        providerStatus = call.response.status;
        model = call.response.model;
        stopReason = call.response.stopReason;
        unit.reviewIssues = call.output;
      } catch (e) {
        if (!(e instanceof ProviderError)) throw e;
        providerStatus = e.status;
        unit.reviewIssues = [];
        note(unit, Codes.REVIEW_UNAVAILABLE, 'The independent review could not be completed.');
      }
      unit.reviewedDraftHash = sha256(draft);
      const blocking = errorCodes(unit.reviewIssues.filter((i) => isBlockingReview(i.code)));
      record('review', errorCodes(unit.reviewIssues));
      if (blocking.length && !unit.repairStopped && unit.attempts < maxRepairs) {
        if (unit.lastReviewCodes && sameCodeSet(unit.lastReviewCodes, blocking)) {
          note(unit, Codes.REPAIR_NO_PROGRESS, 'A repair attempt left the same review findings; repairing stopped early.');
          unit.repairStopped = true;
          unit.stage = 'done';
        } else {
          unit.lastReviewCodes = blocking;
          unit.stage = 'repair';
        }
      } else unit.stage = 'done';
    }

    const ms = Date.now() - t0;
    run.stageLog.push({ stage, unitId: unit.id, at: nowIso(), ms });
    run.updatedAt = nowIso();
    const codes = errorCodes(unitIssues(unit));
    addSpan(run, { id: stageSpanId, name: `stage.${stage}`, kind: 'stage', unitId: unit.id, startedAt: stageStartedAt, ms, attrs: { ...stageAttrs, 'app.platform': unit.platform, 'app.repair.attempts': unit.attempts, 'app.transient.retries': unit.transientRetries, 'app.issue_codes': codes } });
    slog.info('stage complete', { platform: unit.platform, unitId: unit.id, durationMs: ms, attempt: unit.attempts, retries: unit.transientRetries, issueCodes: codes, providerStatus, model, promptVersion: promptVer, stopReason, effort: model ? getConfig('LLM_EFFORT') : undefined, inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens, cacheReadTokens: usage?.cacheReadTokens, cacheWriteTokens: usage?.cacheWriteTokens, costUsd: model ? costUsd(model, usage) : undefined });
    await opts.persist(run);
    opts.onProgress?.({ type: 'stage', stage, unitId: unit.id, status: 'done' });
  }
  return 'done';
}

export function newUnit(id: string, platform: Platform, kind: UnitState['kind'], source: string, origin: UnitState['origin']): UnitState {
  return {
    id, platform, kind, origin, source, stage: 'generate', draft: null, lastUsable: null, config: null, requirements: null, changes: [], suggestions: [], issues: [], notes: [],
    attempts: 0, transientRetries: 0, reviewedDraftHash: null, repairStopped: false, pendingRepair: null, retrieved: { rules: [], examples: [] }, guidance: [], stageCodes: [], firstDraft: null, unknowns: [], models: [],
    reviewIssues: [], lastReviewCodes: null, composed: false,
  };
}
