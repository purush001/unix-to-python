import { ADAPTERS } from '@/adapters';
import { hasPlsql, hasSqlplus, splitScript } from '@/adapters/plsql/splitter';
import { embeddedSql } from '@/adapters/shell-python/shell-parser';
import { PYTHON_SYNTAX_CHECKER } from '@/adapters/shell-python/validators';
import { getConfig, getConfigInt } from '@/config/env';
import { makeAgent, REVIEWER_ROLE, reviewerPromptVersion } from './agent';
import { addSpan, spanClock } from '@/lib/trace';
import { AppError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import { newRunId, nowIso, sha256 } from '@/lib/util';
import { advanceUnit, newUnit, unitIssues, type EngineOptions } from '@/pipeline/engine';
import { Codes, errorCodes, issue, type Issue, type IssueCode } from '@/pipeline/issue-codes';
import type { DraftVersion, OutputFile, Platform, ProgressEvent, RunRecord, ScriptResult, ScriptType, SelectableType, SkillRule, UnitState, Witness } from '@/pipeline/types';
import type { Providers } from '@/providers/types';
import { langOfFile, sanitize, SANITIZER_VERSION, scanSanitized, scanSecrets } from '@/sanitizer';

const UNSUPPORTED: [RegExp, string][] = [
  // wrong content type: not a script at all
  // control bytes that never occur in a text script (ESC is left out: scripts print colour codes with it)
  [/[\u0000-\u0008\u000E-\u001A]|^%PDF-\d/, 'a binary file'],
  // anchored at the start: '<html>' inside a string literal of a real script is not an HTML document
  [/^\s*(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE\s+html\b|<html[\s>])/i, 'an HTML document'],
  [/^#!.*\bpython[\d.]*\b|^\s*if\s+__name__\s*==\s*['"]__main__['"]\s*:/m, 'Python source'],
  [/\b(IDENTIFICATION|PROCEDURE|DATA|ENVIRONMENT)\s+DIVISION\b/i, 'COBOL source'],
  [/^\s*begin-(program|report|select|procedure|setup|heading)\b/im, 'SQR program source'],
  [/^\s*(Local|Global|Component)\s+(string|number|Record|Rowset|boolean|date|any|integer)\s+&\w+/im, 'PeopleCode'],
  [/\b(End-If|End-While|End-For|End-Evaluate|End-Function|End-Method)\s*;/i, 'PeopleCode'],
  [/^\s*SET\s+(LOG|INPUT|OUTPUT)\s+\S+;\s*$/im, 'a Data Mover .dms script'],
  [/^\s*(IMPORT|EXPORT|REPLACE_ALL|REPLACE_DATA)\s+[\w*]+\s*;\s*$/im, 'a Data Mover .dms script'],
  [/<\?xml|<AEAPPLICATION|<ae_application/i, 'an Application Engine definition'],
];

const SHELL_SIGNALS = [/^#!\s*\/\S*(sh|ksh|bash)\b/m, /^\s*(if\s+\[|fi\b|then\b|done\b|esac\b|export\s+\w+=|\w+=\$\(|\w+=`)/m, /\$\{?\w+\}?/, /<<-?\s*['"]?\w+/, /^\s*(echo|cd|rm|cp|mv|mkdir|scp|sftp|ssh|ftp|mailx|sqlplus|sqlldr|psae|psdmtx|pssqr|expdp|impdp|rman|exit)\b/m];
const SQL_SIGNALS = /\b(select|insert\s+into|update|delete\s+from|merge\s+into|create\s+(or\s+replace\s+)?(table|index|view|procedure|function|package|trigger|sequence|synonym)|alter\s+(table|session|system|user)|drop\s+(table|index|view)|declare|begin|grant|truncate\s+table|audit)\b/i;

function isJsonDocument(text: string): boolean {
  const t = text.trim();
  if (!/^[{[]/.test(t) || !/[}\]]$/.test(t)) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

/** Decides what kind of script was pasted. The user's selector overrides auto-detect. */
export function classify(text: string, selected: SelectableType = 'auto'): { type: ScriptType; reason?: string } {
  for (const [re, what] of UNSUPPORTED) if (re.test(text)) return { type: 'unsupported', reason: `This looks like ${what}.` };
  if (isJsonDocument(text)) return { type: 'unsupported', reason: 'This looks like a JSON document.' };
  if (selected !== 'auto') return { type: selected };
  const shellScore = SHELL_SIGNALS.filter((re) => re.test(text)).length;
  const firstLine = text.trimStart().split('\n')[0];
  const looksShell = /^#!/.test(firstLine) || shellScore >= 3 || (shellScore >= 2 && !/^\s*(set|spool|whenever|declare|begin|create|select|prompt|define)\b/im.test(firstLine));
  if (looksShell) return { type: /\bsqlplus\b[^\n]*<</.test(text) ? 'mixed' : 'shell' };
  const segs = splitScript(text);
  const hasSql = segs.some((s) => s.kind === 'sql' && SQL_SIGNALS.test(s.text) && (s.terminated || /;/.test(s.text)));
  if (hasPlsql(segs)) return { type: hasSqlplus(segs) ? 'sqlplus' : 'plsql' };
  if (hasSqlplus(segs) && (hasSql || segs.some((s) => s.kind === 'sqlplus' && /^\s*(exec|@|spool|whenever)/i.test(s.text)))) return { type: 'sqlplus' };
  if (hasSql) return { type: 'sql' };
  return { type: 'unsupported', reason: 'No SQL, PL/SQL, SQL*Plus or shell statements were recognised (it reads like plain text).' };
}

const platformOf = (t: ScriptType): Platform => (t === 'shell' || t === 'mixed' ? 'shell-python' : 'plsql');
const EXT: Record<ScriptType, string> = { sql: 'sql', plsql: 'sql', sqlplus: 'sql', shell: 'sh', mixed: 'sh', unsupported: 'txt' };
export const sourceFileName = (t: ScriptType) => `source.sanitized.${EXT[t]}`;

function splitUnits(text: string, type: ScriptType): UnitState[] {
  const lines = text.split('\n').length;
  if (type !== 'shell' && type !== 'mixed') return [newUnit('sql-1', 'plsql', type, text, { startLine: 1, endLine: lines })];
  const units = embeddedSql(text).map((h, i) => newUnit(`sql-${i + 1}`, 'plsql', 'sqlplus', h.body, { startLine: h.startLine, endLine: h.endLine, embeddedIn: 'shell-1' }));
  return [...units, newUnit('shell-1', 'shell-python', type, text, { startLine: 1, endLine: lines })];
}

/** Puts the converted SQL back into the heredocs before the shell-agent sees the script. */
function compose(shell: UnitState, sqlUnits: UnitState[]): void {
  const lines = shell.source.split('\n');
  for (const u of [...sqlUnits].sort((a, b) => b.origin.startLine - a.origin.startLine)) {
    if (u.draft === null) continue;
    lines.splice(u.origin.startLine - 1, u.origin.endLine - u.origin.startLine + 1, ...u.draft.split('\n'));
  }
  shell.source = lines.join('\n');
  shell.composed = true;
}

const AGENTS = { plsql: makeAgent(ADAPTERS.plsql), 'shell-python': makeAgent(ADAPTERS['shell-python']) } as const;

export interface Deps {
  providers: Providers;
  log: Logger;
}
export interface RunLimits {
  budgetMs: number;
  onProgress?: (e: ProgressEvent) => void;
  extraRules?: SkillRule[];
  skipMemory?: boolean;
  persist?: boolean;
  retryBaseMs?: number;
}

function engineOptions(deps: Deps, limits: RunLimits): EngineOptions {
  return {
    timeoutMs: getConfigInt('PROVIDER_TIMEOUT_MS'),
    transientRetries: getConfigInt('LLM_TRANSIENT_RETRIES'),
    retryBaseMs: limits.retryBaseMs ?? getConfigInt('RETRY_BASE_MS'),
    deadline: Date.now() + limits.budgetMs,
    onProgress: limits.onProgress,
    persist: limits.persist === false ? async () => {} : (run) => deps.providers.storage.saveRun(run),
    extraRules: limits.extraRules,
    skipMemory: limits.skipMemory,
    maxRunTokens: getConfigInt('MAX_RUN_TOKENS'),
  };
}

/**
 * Intake: size limit, classification, sanitization, splitting. The raw input lives in
 * this call only. If the sanitizer throws the run stops here: no provider call is made.
 */
export async function intake(rawSource: string, selected: SelectableType, options: { generateConfig: boolean; maxRepairAttempts?: number }, deps: Deps, limits: RunLimits): Promise<RunRecord> {
  limits.onProgress?.({ type: 'stage', stage: 'intake', unitId: null, status: 'start' });
  const t0 = Date.now();
  const clock = spanClock();
  // input guardrails: size, type, sanitizer. A rejection is logged by code (never by content).
  const reject = (code: IssueCode, message: string, status: number): never => {
    deps.log.child({ stage: 'intake' }).warn('input rejected', { code, bytes: Buffer.byteLength(rawSource, 'utf8') });
    throw new AppError(code, message, status);
  };
  if (!rawSource.trim()) reject(Codes.INPUT_EMPTY, 'The input is empty.', 400);
  if (Buffer.byteLength(rawSource, 'utf8') > getConfigInt('MAX_INPUT_BYTES') || rawSource.split('\n').length > getConfigInt('MAX_INPUT_LINES')) {
    reject(Codes.INPUT_TOO_LARGE, `The script is larger than the limit (${Math.round(getConfigInt('MAX_INPUT_BYTES') / 1024)} KB or ${getConfigInt('MAX_INPUT_LINES')} lines).`, 413);
  }
  const c = classify(rawSource, selected);
  if (c.type === 'unsupported') reject(Codes.INPUT_UNSUPPORTED_TYPE, `${c.reason ?? 'This input type is not supported.'} This tool converts SQL, PL/SQL, SQL*Plus and shell scripts. Convert the wrapper script that launches the program instead.`, 422);
  const platform = platformOf(c.type);
  let s: ReturnType<typeof sanitize>;
  try {
    s = sanitize(rawSource, platform === 'plsql' ? 'sql' : 'shell');
  } catch {
    // fail closed: nothing was sent anywhere
    return reject(Codes.SANITIZE_LEAK_DETECTED, 'The sanitizer could not process this script, so the run was stopped before any provider call.', 422);
  }
  const now = nowIso();
  const run: RunRecord = {
    id: newRunId(), state: 'sanitized', scriptType: c.type, platform, createdAt: now, updatedAt: now,
    options: { generateConfig: options.generateConfig, maxRepairAttempts: options.maxRepairAttempts ?? getConfigInt('MAX_REPAIR_ATTEMPTS') },
    inputHash: sha256(s.text), sanitizedSource: s.text, sanitization: { counts: s.counts, warnings: s.warnings, highlightLines: s.highlightLines },
    units: splitUnits(s.text, c.type), pendingNote: null, drafts: [], reviewerNotes: [], stageLog: [{ stage: 'intake', unitId: null, at: now, ms: Date.now() - t0 }],
    final: null, save: null, rating: null, error: null, learned: false, trace: [], judge: null,
  };
  const replaced = Object.values(s.counts).reduce((a, b) => a + b, 0);
  addSpan(run, { name: 'guardrail.input', kind: 'guardrail', startedAt: clock.startedAt, ms: Date.now() - clock.t0, attrs: { 'app.guardrail.checks': ['size', 'type', 'sanitizer'], 'app.router.decision': c.type, 'app.router.method': selected === 'auto' ? 'rules' : 'user-selected', 'app.sanitizer.version': SANITIZER_VERSION, 'app.sanitizer.replaced': replaced, 'app.sanitizer.warnings': s.warnings.map((w) => w.code), 'app.input.hash': run.inputHash, 'app.units': run.units.length } });
  if (limits.persist !== false) await deps.providers.storage.createRun(run);
  deps.log.child({ runId: run.id, stage: 'intake' }).info('run received', { platform, scriptType: c.type, units: run.units.length, durationMs: Date.now() - t0, replaced: s.counts });
  limits.onProgress?.({ type: 'stage', stage: 'intake', unitId: null, status: 'done', detail: c.type });
  return run;
}

async function finalValidation(run: RunRecord, files: OutputFile[]): Promise<{ codes: IssueCode[]; issues: Issue[]; afterHits: number }> {
  const adapter = ADAPTERS[run.platform];
  const main = files[0];
  const issues = await adapter.validate({ source: run.sanitizedSource, draft: main.content, changes: [], embedded: false });
  let afterHits = 0;
  for (const f of files) {
    const lang = langOfFile(f.name);
    const hits = scanSanitized(f.content, lang);
    afterHits += hits.length;
    for (const h of hits) issues.push(issue(Codes.SANITIZE_LEAK_DETECTED, `Protected item found in ${f.name}.`, h.line, { file: f.name }));
    for (const h of scanSecrets(f.content, lang)) issues.push(issue(Codes.SECRET_IN_OUTPUT, `Possible secret found in ${f.name}.`, h.line, { file: f.name }));
  }
  // object/change-list checks depend on the change list, which is not a committed input
  const reproducible = issues.filter((i) => i.code !== Codes.SQL_STATEMENT_LOST && i.code !== Codes.SQL_OBJECT_RENAMED);
  return { codes: [...new Set(reproducible.map((i) => i.code))].sort(), issues, afterHits };
}

/** Validator codes for a set of committed files. Shared with `npm run verify-witness`. */
export async function reproducibleCodes(platform: Platform, sanitizedSource: string, files: OutputFile[]): Promise<IssueCode[]> {
  return (await finalValidation({ platform, sanitizedSource } as RunRecord, files)).codes;
}

async function buildDraft(run: RunRecord, deps: Deps): Promise<DraftVersion> {
  const mainUnit = run.units[run.units.length - 1];
  const adapter = ADAPTERS[run.platform];
  const files: OutputFile[] = [{ name: `target.${adapter.outputExt}`, kind: run.platform === 'plsql' ? 'sql' : 'python', content: mainUnit.draft ?? '' }];
  if (mainUnit.config) files.push({ name: 'config.ini.template', kind: 'config', content: mainUnit.config });
  if (mainUnit.requirements && run.platform === 'shell-python') files.push({ name: 'requirements.txt', kind: 'requirements', content: mainUnit.requirements });

  const fc = spanClock();
  const fin = await finalValidation(run, files);
  const secretHits = fin.issues.filter((i) => i.code === Codes.SECRET_IN_OUTPUT).length;
  addSpan(run, { name: 'guardrail.output.final', kind: 'guardrail', startedAt: fc.startedAt, ms: Date.now() - fc.t0, status: fin.afterHits || secretHits ? 'error' : 'ok', attrs: { 'app.guardrail.checks': ['leak-scan', 'secret-scan', 'syntax', 'policy-validators'], 'app.guardrail.leak_hits': fin.afterHits, 'app.guardrail.secret_hits': secretHits, 'app.issue_codes': fin.codes, 'app.files': files.map((f) => f.name) } });
  const all: Issue[] = [...run.sanitization.warnings.map((w) => ({ ...w, line: null }))];
  for (const u of run.units) {
    for (const i of unitIssues(u)) {
      if (u === mainUnit) all.push(i);
      else all.push({ ...i, message: `[SQL block at source lines ${u.origin.startLine}-${u.origin.endLine}${i.line ? `, line ${i.line}` : ''}] ${i.message}`, line: null, sourceLine: u.origin.startLine + (i.line ?? 1) - 1 });
    }
  }
  for (const i of fin.issues) if ((i.code === Codes.SANITIZE_LEAK_DETECTED || i.code === Codes.SECRET_IN_OUTPUT) && !all.some((x) => x.code === i.code && x.line === i.line)) all.push(i);
  const seen = new Set<string>();
  const issues = all.filter((i) => {
    const k = `${i.code}|${i.line}|${i.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const version = run.drafts.length + 1;
  const outputHashes = Object.fromEntries(files.map((f) => [f.name, sha256(f.content)]));
  const witness: Witness = {
    runId: run.id, draftVersion: version, inputHash: run.inputHash, outputHash: outputHashes[files[0].name], outputHashes, platform: run.platform, scriptType: run.scriptType,
    validatorVersions: { sanitizer: SANITIZER_VERSION, plsql: ADAPTERS.plsql.validatorVersion, 'shell-python': ADAPTERS['shell-python'].validatorVersion },
    stageCodes: Object.fromEntries(run.units.map((u) => [u.id, u.stageCodes])),
    finalCodes: fin.codes,
    sanitizer: { before: run.sanitization.counts, afterHits: fin.afterHits },
    syntax: [{ file: files[0].name, checker: run.platform === 'plsql' ? 'sql-structure-check' : PYTHON_SYNTAX_CHECKER, ok: !fin.issues.some((i) => i.code === Codes.SQL_PARSE_ERROR || i.code === Codes.PY_SYNTAX_ERROR) }],
    rulesApplied: [...new Set(run.units.flatMap((u) => u.changes.map((c) => c.ruleId)))].sort(),
    retrieved: { rules: [...new Set(run.units.flatMap((u) => u.retrieved.rules))], examples: [...new Set(run.units.flatMap((u) => u.retrieved.examples))] },
    embeddingsModel: deps.providers.embeddings.model,
    models: [...new Set(run.units.flatMap((u) => u.models ?? []))].sort(),
    promptVersions: Object.fromEntries([...[...new Set(run.units.map((u) => u.platform))].map((p) => [AGENTS[p].name, AGENTS[p].promptVersion()] as [string, string]), [REVIEWER_ROLE, reviewerPromptVersion()]]),
    effort: getConfig('LLM_EFFORT'),
    attempts: Object.fromEntries(run.units.map((u) => [u.id, u.attempts])),
    transientRetries: run.units.reduce((s, u) => s + u.transientRetries, 0),
    timestamps: { received: run.createdAt, completed: nowIso() },
  };
  const result: ScriptResult = {
    scriptId: run.id, platform: run.platform, status: errors.length ? 'failed' : warnings.length ? 'ok_with_warnings' : 'ok', draft: files[0].content,
    issues, warnings, changes: run.units.flatMap((u) => (u === mainUnit || !u.origin.embeddedIn ? u.changes : u.changes.map((c) => ({ ...c, lines: `SQL block @${u.origin.startLine}`, ruleId: c.ruleId })))),
    attempts: run.units.reduce((s, u) => s + u.attempts, 0), witness,
  };
  return {
    version, createdAt: nowIso(), note: run.pendingNote, files, result,
    suggestions: run.units.flatMap((u) => u.suggestions).filter((s, i, a) => a.findIndex((x) => x.title === s.title) === i),
    unitResults: run.units.map((u) => ({ unitId: u.id, platform: u.platform, kind: u.kind, origin: u.origin, attempts: u.attempts, codes: errorCodes(unitIssues(u)) })),
  };
}

/**
 * Runs (or resumes) the pipeline for every unit, embedded SQL first, then assembles the
 * draft. Returns with state "drafting" when the request budget ran out; call again to resume.
 */
export async function continueRun(run: RunRecord, deps: Deps, limits: RunLimits): Promise<RunRecord> {
  const opts = engineOptions(deps, limits);
  run.state = 'drafting';
  const sqlUnits = run.units.filter((u) => u.origin.embeddedIn);
  try {
    for (const unit of run.units) {
      if (unit.platform === 'shell-python' && !unit.composed) {
        compose(unit, sqlUnits);
        await opts.persist(run);
      }
      if ((await advanceUnit(run, unit, deps, opts)) === 'paused') {
        deps.log.child({ runId: run.id }).info('request budget reached; run can be resumed', { unitId: unit.id, nextStage: unit.stage });
        return run;
      }
    }
    limits.onProgress?.({ type: 'stage', stage: 'results', unitId: null, status: 'start' });
    const t0 = Date.now();
    run.drafts.push(await buildDraft(run, deps));
    run.pendingNote = null;
    run.state = 'draft_ready';
    run.updatedAt = nowIso();
    run.stageLog.push({ stage: 'results', unitId: null, at: run.updatedAt, ms: Date.now() - t0 });
    await opts.persist(run);
    const d = run.drafts[run.drafts.length - 1];
    deps.log.child({ runId: run.id, stage: 'results' }).info('draft ready', { status: d.result.status, platform: run.platform, attempt: d.result.attempts, retries: d.result.witness.transientRetries, issueCodes: [...new Set(d.result.issues.map((i) => i.code))] });
    limits.onProgress?.({ type: 'stage', stage: 'results', unitId: null, status: 'done', detail: d.result.status });
    return run;
  } catch (e) {
    const err = e as { code?: string; status?: number; message?: string; failure?: string; name?: string };
    run.state = 'failed';
    run.error = { code: err.name === 'ProviderError' ? 'PROVIDER_ERROR' : (err.code ?? 'INTERNAL_ERROR'), message: err.name === 'ProviderError' || err.name === 'AppError' ? (err.message ?? 'failed') : 'The run failed.', status: err.status ?? 500 };
    run.updatedAt = nowIso();
    try {
      await opts.persist(run);
    } catch {
      /* the original error is the one to report */
    }
    deps.log.child({ runId: run.id }).error('run failed', { code: run.error.code, providerStatus: err.status, failure: err.failure });
    throw e;
  }
}

/** Request changes: a new pass over the same sanitized source with the reviewer's note. */
export function beginRevision(run: RunRecord, rawNote: string): void {
  if (run.state !== 'draft_ready' && run.state !== 'changes_requested') throw new AppError('INVALID_STATE', `A run in state "${run.state}" cannot be revised.`, 409, run.id);
  const note = sanitize(rawNote.trim(), 'text').text;
  run.state = 'changes_requested';
  run.reviewerNotes.push({ at: nowIso(), note });
  run.pendingNote = note;
  run.units = splitUnits(run.sanitizedSource, run.scriptType);
  run.updatedAt = nowIso();
}
