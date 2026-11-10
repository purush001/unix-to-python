import { Codes, issue, type Issue } from '@/pipeline/issue-codes';
import type { Change } from '@/pipeline/types';
import { analyzeBlocks, ownedBlocks } from './blocks';
import { scanDesupported, scanDualCompat } from './compat';
import { splitScript, type Segment } from './splitter';
import { code, tokenize, type Tok } from './tokenizer';

export const PLSQL_VALIDATOR_VERSION = '1.0.0';

/** Structure check: quotes, comments, parentheses, blocks and terminators. */
export function parseCheck(text: string): Issue[] {
  const out: Issue[] = [];
  const segs = splitScript(text);
  for (const s of segs) {
    if (s.kind !== 'sql' && s.kind !== 'plsql') continue;
    const off = s.startLine - 1;
    const { tokens, errors } = tokenize(s.text);
    for (const e of errors) out.push(issue(Codes.SQL_PARSE_ERROR, e.message, e.line + off, { column: e.col }));
    const stack: Tok[] = [];
    for (const t of code(tokens)) {
      if (t.type !== 'punct') continue;
      if (t.text === '(') stack.push(t);
      else if (t.text === ')') {
        if (!stack.pop()) out.push(issue(Codes.SQL_PARSE_ERROR, 'Closing parenthesis without an opening one', t.line + off, { column: t.col }));
      }
    }
    for (const t of stack) out.push(issue(Codes.SQL_PARSE_ERROR, 'Parenthesis is never closed', t.line + off, { column: t.col }));
    if (s.kind === 'plsql') {
      for (const e of analyzeBlocks(s.text, s.plsqlType ?? 'anonymous').errors) out.push(issue(Codes.SQL_PARSE_ERROR, e.message, e.line + off, { column: e.col }));
      if (!s.terminated) out.push(issue(Codes.SQL_PARSE_ERROR, 'PL/SQL unit is not terminated by a line containing only "/"', s.endLine));
    } else if (!s.terminated) {
      out.push(issue(Codes.SQL_PARSE_ERROR, 'SQL statement is not terminated by ";" or "/"', s.endLine));
    }
  }
  return out;
}

function swallowCount(segs: Segment[]): number {
  let n = 0;
  for (const s of segs) if (s.kind === 'plsql') n += analyzeBlocks(s.text, s.plsqlType ?? 'anonymous').blocks.filter((b) => b.othersThen !== -1 && !b.reraises).length;
  return n;
}

/** Section 9.5: every owned PL/SQL unit records line and message; SQL*Plus keeps the output. */
export function errorCaptureCheck(source: string, draft: string, embedded: boolean): Issue[] {
  const out: Issue[] = [];
  const segs = splitScript(draft);
  const srcSegs = splitScript(source);
  const sourceSwallows = swallowCount(srcSegs);
  let swallows = 0;
  for (const s of segs) {
    if (s.kind !== 'plsql') continue;
    const type = s.plsqlType ?? 'anonymous';
    const a = analyzeBlocks(s.text, type);
    const off = s.startLine - 1;
    for (const b of ownedBlocks(a, type)) {
      const line = a.toks[b.begin].line + off;
      if (b.othersThen === -1) out.push(issue(Codes.SQL_NO_ERROR_CAPTURE, 'The outermost block has no WHEN OTHERS handler that records SQLCODE, FORMAT_ERROR_STACK and FORMAT_ERROR_BACKTRACE.', line));
      else if (!b.hasCapture) out.push(issue(Codes.SQL_NO_ERROR_CAPTURE, 'The WHEN OTHERS handler does not write the ERROR|unit=…|line=…|code=…|message=… capture line through DBMS_OUTPUT.', a.toks[b.othersThen].line + off));
    }
    for (const b of a.blocks) {
      if (b.othersThen === -1 || b.reraises) continue;
      swallows++;
      const line = a.toks[b.othersThen].line + off;
      if (!b.hasCapture) out.push(issue(Codes.SQL_NO_ERROR_CAPTURE, 'A handler that swallows the error must still write the capture line.', line));
      else out.push(issue(Codes.SQL_ERROR_SWALLOWED, 'This WHEN OTHERS handler does not re-raise; the error is logged and execution continues, as in the source.', line));
    }
  }
  if (swallows > sourceSwallows) out.push(issue(Codes.SQL_NO_ERROR_CAPTURE, 'A new handler swallows the error. Added handlers must re-raise with RAISE so behaviour and exit codes are unchanged.', null));

  const hasPl = segs.some((s) => s.kind === 'plsql');
  const isScript = segs.some((s) => s.kind === 'sqlplus') || hasPl || embedded;
  if (isScript) {
    const firstExec = segs.find((s) => s.kind === 'plsql' || s.kind === 'sql');
    const so = segs.find((s) => s.kind === 'sqlplus' && /^\s*set\s+serverout(put)?\s+on\b/i.test(s.text));
    if (!so || (firstExec && so.startLine > firstExec.startLine)) {
      out.push(issue(Codes.SQL_NO_ERROR_CAPTURE, 'SET SERVEROUTPUT ON must come before the first statement so the capture line reaches the log.', firstExec?.startLine ?? 1));
    }
    if (!embedded && !segs.some((s) => s.kind === 'sqlplus' && /^\s*spo(ol)?\s+(?!off\b)\S/i.test(s.text))) {
      out.push(issue(Codes.SQL_OUTPUT_NOT_SPOOLED, 'The script does not SPOOL its output; the SQL*Plus error report and the capture line only reach standard output.', null));
    }
  }
  const srcExit = srcSegs.filter((s) => s.kind === 'sqlplus' && /^\s*whenever\s+sqlerror\s+exit/i.test(s.text)).length;
  const outExit = segs.filter((s) => s.kind === 'sqlplus' && /^\s*whenever\s+sqlerror\s+exit/i.test(s.text));
  if (outExit.length > srcExit) out.push(issue(Codes.REVIEW_EXIT_CODE_CHANGED, 'WHENEVER SQLERROR EXIT was added, but the source continued past errors.', outExit[0].startLine));
  return out;
}

const OBJECT_INTRO = new Set(['FROM', 'JOIN', 'UPDATE', 'TABLE', 'VIEW', 'INTO', 'TRUNCATE', 'INDEX', 'SEQUENCE', 'SYNONYM', 'PROCEDURE', 'FUNCTION', 'PACKAGE', 'TRIGGER', 'BODY', 'CALL', 'EXEC', 'EXECUTE']);
const NOT_OBJECTS = new Set(['DUAL', 'SELECT', 'TABLE', 'ONLY', 'LATERAL', 'THE', 'XMLTABLE', 'JSON_TABLE', 'IMMEDIATE', 'BODY', 'IF', 'OR', 'REPLACE', 'SET', 'VALUES', 'UNNEST']);

/** Tables, views and PL/SQL objects a script refers to (upper case). */
export function referencedObjects(text: string): Map<string, number> {
  const toks = code(tokenize(text).tokens);
  const out = new Map<string, number>();
  const add = (name: string, line: number) => {
    const n = name.toUpperCase();
    if (!NOT_OBJECTS.has(n) && !/^[A-Z]$/.test(n) && !out.has(n)) out.set(n, line);
  };
  let inFuncFrom = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.type === 'string') {
      const v = t.text.slice(1, -1).replace(/''/g, "'");
      if (/^\s*(select|insert|update|delete|merge|create|alter|drop|truncate|begin)\b/i.test(v)) for (const [k, l] of referencedObjects(v)) add(k, t.line + l - 1);
      continue;
    }
    if (t.type !== 'word') continue;
    if ((t.up === 'EXTRACT' || t.up === 'TRIM' || t.up === 'SUBSTRING') && toks[i + 1]?.text === '(') inFuncFrom = 1;
    if (t.up === 'FROM' && inFuncFrom) {
      inFuncFrom = 0;
      continue;
    }
    if (/^PS[A-Z0-9]*_[A-Z0-9_]+$|^PS[A-Z]{4,}$/.test(t.up) && !/^PSQL/.test(t.up)) add(t.up, t.line);
    if (!OBJECT_INTRO.has(t.up)) continue;
    if (t.up === 'INTO' && !toks.slice(Math.max(0, i - 3), i).some((x) => x.up === 'INSERT' || x.up === 'MERGE')) continue;
    const n = toks[i + 1];
    if (!n || (n.type !== 'word' && n.type !== 'qident')) continue;
    let name = n.text.replace(/"/g, '');
    if (toks[i + 2]?.text === '.' && toks[i + 3] && (toks[i + 3].type === 'word' || toks[i + 3].type === 'qident')) name = toks[i + 3].text.replace(/"/g, '');
    if (/^[A-Za-z][\w$#]*$/.test(name)) add(name, n.line);
  }
  return out;
}

export function objectCheck(source: string, draft: string, changes: Change[]): Issue[] {
  const out: Issue[] = [];
  const draftWords = new Set((draft.toUpperCase().match(/[A-Z_][A-Z0-9_$#]*/g) ?? []));
  const explained = changes.map((c) => `${c.summary} ${c.reason}`.toUpperCase()).join('\n');
  for (const [name, line] of referencedObjects(source)) {
    if (draftWords.has(name)) continue;
    if (explained.includes(name)) out.push(issue(Codes.SQL_OBJECT_RENAMED, `${name} is no longer referenced; the change list explains why.`, null, { sourceLine: line }));
    else out.push(issue(Codes.SQL_STATEMENT_LOST, `${name} is referenced in the source (line ${line}) but not in the output, and the change list does not explain it.`, null, { sourceLine: line }));
  }
  return out;
}

export function variableCheck(source: string, draft: string): Issue[] {
  const vars = (text: string) => {
    const m = new Map<string, number>();
    for (const t of code(tokenize(text).tokens)) {
      if (t.type === 'subst') m.set('&' + t.text.replace(/^&+/, '').replace(/\.$/, '').toLowerCase(), t.line);
      // SQL*Plus also substitutes inside string literals
      if (t.type === 'string') for (const x of t.text.matchAll(/&&?([A-Za-z0-9_]+)/g)) m.set('&' + x[1].toLowerCase(), t.line);
      if (t.type === 'bind') m.set(t.text.toLowerCase(), t.line);
    }
    return m;
  };
  const d = vars(draft);
  const out: Issue[] = [];
  for (const [v, line] of vars(source)) if (!d.has(v)) out.push(issue(Codes.SQL_SUBSTITUTION_LOST, `${v} is used in the source (line ${line}) but is missing from the output.`, null, { sourceLine: line }));
  return out;
}

/** COMMIT inside a loop: behaviour is kept, the reviewer is warned. */
export function commitInLoopCheck(draft: string): Issue[] {
  const out: Issue[] = [];
  for (const s of splitScript(draft)) {
    if (s.kind !== 'plsql') continue;
    const toks = code(tokenize(s.text).tokens);
    let loops = 0;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.type !== 'word') continue;
      if (t.up === 'LOOP') loops += toks[i - 1]?.up === 'END' ? -1 : 1;
      if (t.up === 'COMMIT' && loops > 0) out.push(issue(Codes.SQL_COMMIT_IN_LOOP, 'COMMIT inside a loop was kept as in the source.', t.line + s.startLine - 1));
    }
  }
  return out;
}

export function compatCheck(draft: string): Issue[] {
  const out: Issue[] = [];
  for (const s of splitScript(draft)) {
    if (s.kind === 'sqlplus' && /^\s*(argument|config|oerr|ping)\b|^\s*set\s+errordetails\b/i.test(s.text)) {
      out.push(issue(Codes.SQL_NOT_DUAL_COMPATIBLE, 'This SQL*Plus command exists only in the 26ai client.', s.startLine));
    }
    if (s.kind !== 'sql' && s.kind !== 'plsql' && !(s.kind === 'sqlplus' && /^\s*exec(ute)?\b/i.test(s.text))) continue;
    out.push(...scanDualCompat(s.text, { plsql: s.kind !== 'sql', lineOffset: s.startLine - 1 }));
    out.push(...scanDesupported(s.text, s.startLine - 1));
  }
  return out;
}

export interface PlsqlValidateInput {
  source: string;
  draft: string;
  changes: Change[];
  embedded: boolean;
}
export function validatePlsql(v: PlsqlValidateInput): Issue[] {
  return [
    ...parseCheck(v.draft),
    ...compatCheck(v.draft),
    ...errorCaptureCheck(v.source, v.draft, v.embedded),
    ...objectCheck(v.source, v.draft, v.changes),
    ...variableCheck(v.source, v.draft),
    ...commitInLoopCheck(v.draft),
  ];
}
