import { ADAPTERS } from '@/adapters';
import { review as reviewCall } from '@/agents/agent';
import { shellAgent } from '@/agents/shell-agent';
import { sqlAgent } from '@/agents/sql-agent';
import { ProviderError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import { nowIso, sha256, sleep } from '@/lib/util';
import { retrieveGuidance } from '@/learning/memory';
import type { Providers } from '@/providers/types';
import { sanitize, scanSecrets, type Lang } from '@/sanitizer';
import { detectConstructs } from './constructs';
import { Codes, errorCodes, isBlockingReview, issue, sameCodeSet, type Issue, type IssueCode } from './issue-codes';
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
}
export interface EngineDeps {
  providers: Providers;
  log: Logger;
}

const AGENTS = { plsql: sqlAgent, 'shell-python': shellAgent } as const;
const LANG: Record<Platform, Lang> = { plsql: 'sql', 'shell-python': 'python' };
const LEAK_CODES: IssueCode[] = [Codes.SANITIZE_LEAK_DETECTED, Codes.SECRET_IN_OUTPUT];

/**
 * Retries transient provider failures (malformed or empty output, 5xx, timeout, network)
 * up to `transientRetries` times with backoff and jitter. These retries never count as
 * repair attempts. Non-transient errors (for example 429) are thrown at once.
 */
export async function withTransientRetry<T>(fn: () => Promise<T>, unit: Pick<UnitState, 'transientRetries'>, opts: Pick<EngineOptions, 'transientRetries' | 'retryBaseMs'>, log?: Logger): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
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
function scrub(text: string, lang: Lang): { text: string; issues: Issue[] } {
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

function setDraft(unit: UnitState, platform: Platform, out: { converted: string; changes: UnitState['changes']; suggestions: UnitState['suggestions']; config: string | null; requirements: string | null }): void {
  const d = scrub(out.converted, LANG[platform]);
  const c = out.config ? scrub(out.config, 'ini') : null;
  unit.draft = d.text;
  unit.config = c ? c.text : null;
  unit.requirements = out.requirements ? scrub(out.requirements, 'text').text : null;
  unit.changes = out.changes.map((ch) => ({ ...ch, summary: sanitize(ch.summary, 'text').text, reason: sanitize(ch.reason, 'text').text }));
  unit.suggestions = out.suggestions.map((s) => ({ title: sanitize(s.title, 'text').text, detail: sanitize(s.detail, 'text').text }));
  unit.notes = [...unit.notes.filter((n) => !LEAK_CODES.includes(n.code)), ...d.issues, ...(c?.issues ?? [])];
  unit.firstDraft ??= unit.draft;
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

  while (unit.stage !== 'done') {
    if (Date.now() >= opts.deadline) return 'paused';
    const stage = unit.stage;
    const t0 = Date.now();
    opts.onProgress?.({ type: 'stage', stage, unitId: unit.id, status: 'start' });
    const slog = log.child({ stage });
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    let providerStatus: number | undefined;

    if (stage === 'generate') {
      if (!opts.skipMemory && unit.guidance.length === 0) {
        const r = await retrieveGuidance(deps.providers, { platform: unit.platform, tags: detectConstructs(unit.source, unit.platform), excerpt: unit.source.slice(0, 1500), extraRules: opts.extraRules });
        unit.guidance = r.guidance;
        unit.retrieved = { rules: r.rules, examples: r.examples };
        if (r.warning) unit.notes.push(r.warning);
        slog.info('memory retrieval', { ms: r.ms, ruleHits: r.rules.length, exampleHits: r.examples.length, unavailable: !!r.warning });
      }
      // Nothing drafted yet: a provider error here is thrown so the API returns its real status.
      const call = await withTransientRetry(() => agent.generate(llm, input(), opts.timeoutMs), unit, opts, slog);
      usage = call.response.usage;
      providerStatus = call.response.status;
      setDraft(unit, unit.platform, call.output);
      unit.stage = 'validate';
    } else if (stage === 'validate') {
      const draft = unit.draft ?? '';
      unit.issues = await adapter.validate({ source: unit.source, draft, changes: unit.changes, embedded: !!unit.origin.embeddedIn });
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
      if (now.length && !unit.repairStopped && unit.attempts < maxRepairs) {
        unit.pendingRepair = now;
        unit.stage = 'repair';
      } else unit.stage = unit.reviewedDraftHash === sha256(draft) ? 'done' : 'review';
    } else if (stage === 'repair') {
      const blockingReview = unit.reviewIssues.filter((i) => isBlockingReview(i.code));
      const toFix = [...unit.issues, ...unit.notes.filter((n) => LEAK_CODES.includes(n.code)), ...blockingReview].filter((i) => i.severity === 'error');
      try {
        const call = await withTransientRetry(() => agent.repair(llm, { ...input(), draft: unit.draft ?? '', issues: toFix }, opts.timeoutMs), unit, opts, slog);
        usage = call.response.usage;
        providerStatus = call.response.status;
        unit.attempts++;
        setDraft(unit, unit.platform, call.output);
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
        const call = await withTransientRetry(() => reviewCall(adapter, llm, { source: unit.source, draft }, opts.timeoutMs), unit, opts, slog);
        usage = call.response.usage;
        providerStatus = call.response.status;
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
    slog.info('stage complete', { platform: unit.platform, unitId: unit.id, durationMs: ms, attempt: unit.attempts, retries: unit.transientRetries, issueCodes: errorCodes(unitIssues(unit)), providerStatus, inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens });
    await opts.persist(run);
    opts.onProgress?.({ type: 'stage', stage, unitId: unit.id, status: 'done' });
  }
  return 'done';
}

export function newUnit(id: string, platform: Platform, kind: UnitState['kind'], source: string, origin: UnitState['origin']): UnitState {
  return {
    id, platform, kind, origin, source, stage: 'generate', draft: null, lastUsable: null, config: null, requirements: null, changes: [], suggestions: [], issues: [], notes: [],
    attempts: 0, transientRetries: 0, reviewedDraftHash: null, repairStopped: false, pendingRepair: null, retrieved: { rules: [], examples: [] }, guidance: [], stageCodes: [], firstDraft: null,
    reviewIssues: [], lastReviewCodes: null, composed: false,
  };
}
