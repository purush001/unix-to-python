import { ADAPTERS } from '@/adapters';
import { hasPlsql, hasSqlplus, splitScript } from '@/adapters/plsql/splitter';
import { embeddedSql } from '@/adapters/shell-python/shell-parser';
import { RUNTIME_FILE, runtimeModule, usesRuntimeModule } from '@/adapters/shell-python/runtime';
import { PYTHON_SYNTAX_CHECKER } from '@/adapters/shell-python/validators';
import { getConfig, getConfigInt } from '@/config/env';
import { makeAgent, REVIEWER_ROLE, reviewerPromptVersion } from './agent';
import { addSpan, spanClock } from '@/lib/trace';
import { AppError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import { newRunId, nowIso, sha256 } from '@/lib/util';
import { advanceUnit, LEAK_CODES, newUnit, scrub, unitIssues, unknownRuleIds, type EngineOptions } from '@/pipeline/engine';
import { RULE_REVIEWER_EDIT } from './prompts';
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

/** A Ctrl-Z at the very end is the DOS end-of-file marker that old editors leave behind, not content. */
const stripDosEof = (text: string): string => text.replace(/\u001a+\s*$/, '\n');

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
export function classify(rawText: string, selected: SelectableType = 'auto'): { type: ScriptType; reason?: string } {
  const text = stripDosEof(rawText);
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
  // everyday input the strict rules miss: a query with no ";" or a few commands with no "#!" line
  const lenient = classifyLenient(text);
  if (lenient) return { type: lenient };
  return { type: 'unsupported', reason: 'No SQL, PL/SQL, SQL*Plus or shell statements were recognised (it reads like plain text).' };
}

const STOPWORDS = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'please', 'you', 'your', 'we', 'our', 'i', 'me', 'my', 'that', 'this', 'these', 'those', 'will', 'would', 'should', 'could', 'have', 'has', 'had', 'because', 'thanks', 'let', 'know', 'anyone', 'it', 'its', 'they', 'them', 'their', 'of', 'about']);
const SQL_START =
  /^\s*(?:select\b[\s\S]*?\bfrom\b|insert\s+into\s+[\w."$]+|update\s+[\w."$]+\s+(?:\w+\s+)?set\b|delete\s+(?:from\s+)?[\w."$]+\s*(?:where\b|;|$)|merge\s+into\b|create\s+(?:or\s+replace\s+)?(?:global\s+temporary\s+|unique\s+|public\s+|materialized\s+)?(?:table|index|view|sequence|synonym|procedure|function|package|trigger|type|user|role|directory)\b|alter\s+(?:table|session|system|user|index)\b|drop\s+(?:table|index|view|sequence|synonym|procedure|function|package|trigger)\b|truncate\s+table\b|with\s+[\w"]+\s+as\s*\(|comment\s+on\b)/i;
const SHELL_LINE =
  /^(?:[A-Za-z_]\w*=\S*|\w+\s*\(\)\s*\{?\s*$|[{}]\s*$|(?:export|ls|cd|cp|mv|rm|mkdir|rmdir|touch|cat|echo|print|printf|grep|egrep|awk|sed|sort|uniq|wc|head|tail|cut|tr|find|xargs|tar|gzip|gunzip|zip|unzip|chmod|chown|date|sleep|kill|ps|df|du|nohup|sqlplus|sqlldr|expdp|impdp|rman|exp|imp|lsnrctl|tnsping|ssh|scp|sftp|ftp|rsync|mailx|mail|psae|psdmtx|pssqr|if|then|else|elif|fi|for|while|until|do|done|case|esac|function|return|exit|unset|source|trap|test|\[|\.)(?=\s|;|$))/;

/**
 * A second, more generous look. It accepts input that starts like a SQL statement, or whose
 * lines mostly start with shell commands, as long as it does not read like prose. Command
 * names are matched in lower case only, so "Find the file" is not taken for a command.
 */
function classifyLenient(text: string): ScriptType | null {
  const code = text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((l) => !/^\s*(--|#|rem\b)/i.test(l))
    .join('\n');
  const bare = code.replace(/'(?:[^'\n]|'')*'|"[^"\n]*"/g, "''");
  const lines = bare.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  // prose: common English words, or lines that end like sentences
  const words = bare.toLowerCase().match(/[a-z']+/g) ?? [];
  const stop = words.filter((w) => STOPWORDS.has(w)).length;
  if (words.length >= 5 && stop / words.length > 0.12) return null;
  if (lines.filter((l) => /[a-z]{2,}[.!?]$/.test(l) && l.split(/\s+/).length >= 4).length > 0) return null;
  if (SQL_START.test(bare)) return 'sql';
  const shellLines = lines.filter((l) => SHELL_LINE.test(l)).length;
  if (shellLines / lines.length >= 0.6) return /\bsqlplus\b[^\n]*<</.test(text) ? 'mixed' : 'shell';
  return null;
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
export async function intake(pasted: string, selected: SelectableType, options: { generateConfig: boolean; maxRepairAttempts?: number }, deps: Deps, limits: RunLimits): Promise<RunRecord> {
  limits.onProgress?.({ type: 'stage', stage: 'intake', unitId: null, status: 'start' });
  const t0 = Date.now();
  const rawSource = stripDosEof(pasted);
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
  if (c.type === 'unsupported') reject(Codes.INPUT_UNSUPPORTED_TYPE, `${c.reason ?? 'This input type is not supported.'} This tool converts SQL, PL/SQL, SQL*Plus and shell scripts. ${/reads like plain text/.test(c.reason ?? '') && selected === 'auto' ? 'If this is a script, choose its type under "Script type" and convert again.' : 'Convert the wrapper script that launches the program instead.'}`, 422);
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
  // the shared runtime is written by this application, never by the model
  if (run.platform === 'shell-python' && usesRuntimeModule(files[0].content)) files.push({ name: RUNTIME_FILE, kind: 'runtime', content: runtimeModule() });

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

/** Output can be several times the input; an edit may not exceed this multiple of the input limit. */
const EDIT_SIZE_FACTOR = 4;

/**
 * A person edits the latest draft in the target editor. The edit goes through the same output
 * guardrails as model output (anything protected is stripped and reported) and the same code
 * validators, then becomes a new draft version. No model is called, so the independent review
 * does not run on it; the new version says so. Earlier versions are kept.
 */
export async function applyEdit(run: RunRecord, fileName: string, rawContent: string, rawNote: string, deps: Deps): Promise<RunRecord> {
  if (run.state !== 'draft_ready') throw new AppError('INVALID_STATE', `A run in state "${run.state}" cannot be edited.`, 409, run.id);
  const prev = run.drafts[run.drafts.length - 1];
  const file = prev?.files.find((f) => f.name === fileName);
  if (!prev || !file) throw new AppError('BAD_REQUEST', 'The latest draft has no file with that name.', 400, run.id);
  if (file.kind === 'runtime') throw new AppError('FILE_NOT_EDITABLE', `${RUNTIME_FILE} is the shared runtime and is the same for every script. It cannot be edited here.`, 422, run.id);
  const content = rawContent.replace(/\r\n?/g, '\n');
  if (!content.trim()) throw new AppError(Codes.INPUT_EMPTY, 'The edited file is empty.', 400, run.id);
  if (Buffer.byteLength(content, 'utf8') > getConfigInt('MAX_INPUT_BYTES') * EDIT_SIZE_FACTOR) throw new AppError(Codes.INPUT_TOO_LARGE, 'The edited file is larger than the limit.', 413, run.id);
  const unit = run.units[run.units.length - 1];
  const adapter = ADAPTERS[run.platform];
  const clock = spanClock();
  // a hand edit passes the same output guardrail as model output: only sanitized text is stored
  const cleaned = scrub(content, langOfFile(fileName));
  if (cleaned.text === file.content) throw new AppError('NO_CHANGE', 'The edited text is the same as the current draft.', 400, run.id);
  if (file.kind === 'config') unit.config = cleaned.text;
  else if (file.kind === 'requirements') unit.requirements = cleaned.text;
  else unit.draft = cleaned.text;
  const note = sanitize(rawNote.trim(), 'text').text;
  unit.changes = [...unit.changes, { ruleId: RULE_REVIEWER_EDIT, lines: '-', summary: `${fileName} was edited by the reviewer`, reason: note || 'Manual edit in the target editor.', risk: 'medium' }];
  unit.issues = [
    ...(await adapter.validate({ source: unit.source, draft: unit.draft ?? '', changes: unit.changes, embedded: false })),
    ...unknownRuleIds(unit).map((id) => issue(Codes.CHANGE_RULE_UNKNOWN, `The change list cites rule ID "${id.slice(0, 80)}", which was not supplied and is not built in.`, null)),
  ];
  // the reviewer's findings were about the earlier text
  unit.reviewIssues = [];
  unit.reviewedDraftHash = null;
  unit.notes = [
    ...unit.notes.filter((n) => !LEAK_CODES.includes(n.code) && n.code !== Codes.DRAFT_EDITED_BY_REVIEWER),
    ...cleaned.issues,
    issue(Codes.DRAFT_EDITED_BY_REVIEWER, `${fileName} was edited by hand. The code checks ran on the edit; the independent review did not.`, null),
  ];
  const codes = errorCodes(unitIssues(unit));
  unit.stageCodes.push({ validate: codes });
  addSpan(run, { name: 'stage.edit', kind: 'stage', unitId: unit.id, startedAt: clock.startedAt, ms: Date.now() - clock.t0, attrs: { 'app.edit.file': fileName, 'app.issue_codes': codes, 'app.validator.version': adapter.validatorVersion } });
  addSpan(run, { name: 'guardrail.output.scrub', kind: 'guardrail', unitId: unit.id, startedAt: clock.startedAt, ms: 0, status: cleaned.issues.length ? 'error' : 'ok', attrs: { 'app.guardrail.hits': cleaned.issues.length, 'app.guardrail.action': cleaned.issues.length ? 'stripped' : 'pass', 'app.guardrail.source': 'reviewer-edit' } });
  run.pendingNote = `Edited by the reviewer: ${fileName}${note ? `. ${note}` : ''}`;
  const draft = await buildDraft(run, deps);
  draft.editedFile = fileName;
  run.drafts.push(draft);
  run.pendingNote = null;
  run.updatedAt = nowIso();
  await deps.providers.storage.saveRun(run);
  deps.log.child({ runId: run.id, stage: 'edit' }).info('draft edited by reviewer', { version: draft.version, status: draft.result.status, issueCodes: codes, stripped: cleaned.issues.length });
  return run;
}

/**
 * The reviewer removes a change-list item or a warning from view, or restores it. Nothing is
 * deleted: the item stays in the stored draft, the witness and the saved report, marked as
 * removed. An error can never be removed: it has to be fixed.
 */
export async function setDismissed(run: RunRecord, version: number, kind: 'change' | 'issue', index: number, dismissed: boolean, deps: Deps): Promise<RunRecord> {
  if (run.final !== null || (run.state !== 'draft_ready' && run.state !== 'changes_requested')) throw new AppError('INVALID_STATE', `A run in state "${run.state}" is a fixed record; its lists can no longer be changed.`, 409, run.id);
  const draft = run.drafts.find((d) => d.version === version);
  if (!draft) throw new AppError('NOT_FOUND', 'No such draft version.', 404, run.id);
  const list = kind === 'change' ? draft.result.changes : draft.result.issues;
  if (index < 0 || index >= list.length) throw new AppError('BAD_REQUEST', 'No such item.', 400, run.id);
  if (kind === 'issue' && draft.result.issues[index].severity === 'error') throw new AppError('ISSUE_NOT_DISMISSIBLE', 'An error cannot be removed from the list. Fix it by editing the target or requesting changes.', 422, run.id);
  const d = (draft.dismissed ??= { changes: [], issues: [] });
  const key = kind === 'change' ? 'changes' : 'issues';
  const set = new Set(d[key]);
  if (dismissed) set.add(index);
  else set.delete(index);
  d[key] = [...set].sort((a, b) => a - b);
  run.updatedAt = nowIso();
  await deps.providers.storage.saveRun(run);
  deps.log.child({ runId: run.id, stage: 'review' }).info(dismissed ? 'item removed from view' : 'item restored', { version, kind, code: kind === 'issue' ? draft.result.issues[index].code : draft.result.changes[index].ruleId });
  return run;
}
