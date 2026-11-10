import { instrumentUnit } from '@/adapters/plsql/blocks';
import { splitScript } from '@/adapters/plsql/splitter';
import type { Change, Suggestion } from '@/pipeline/types';

export interface SqlConversion {
  sql: string;
  changes: Change[];
  suggestions: Suggestion[];
}

const SPOOL_FILE = 'script_output.log';

/** Adds SPOOL before the first statement and SPOOL OFF at the end. Returns null when the script already spools. */
function addSpool(sql: string): string | null {
  const lines = sql.split('\n');
  if (lines.some((l) => /^\s*spo(ol)?\s+(?!off\b)\S/i.test(l))) return null;
  // after the leading SQL*Plus SET / WHENEVER / comment lines
  let at = 0;
  while (at < lines.length && /^\s*(set\s|whenever\s|--|rem\b|prompt\b|$)/i.test(lines[at])) at++;
  lines.splice(at, 0, `SPOOL ${SPOOL_FILE}`);
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end--;
  if (end > 0 && /^\s*(exit|quit)\b/i.test(lines[end - 1])) end--;
  lines.splice(end, 0, 'SPOOL OFF');
  return lines.join('\n');
}

/**
 * Moves a COMMIT that stands alone on a line inside a loop to just after that loop. Leaves the
 * script alone (returns null) when the COMMIT is conditional or shares its line with other code:
 * those need a person.
 */
function commitAfterLoop(sql: string): string | null {
  const lines = sql.split('\n');
  const code = (l: string) => l.replace(/--.*$/, '').replace(/'(?:[^']|'')*'/g, "''");
  const sig = (i: number, step: number) => {
    for (let k = i + step; k >= 0 && k < lines.length; k += step) if (code(lines[k]).trim()) return code(lines[k]).trim();
    return '';
  };
  let depth = 0;
  let pending = false;
  let moved = false;
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const c = code(lines[i]);
    const closes = (c.match(/\bend\s+loop\b/gi) ?? []).length;
    const opens = (c.match(/\bloop\b/gi) ?? []).length - closes;
    if (depth > 0 && /^\s*commit\s*;\s*$/i.test(c) && !/\b(then|else)$/i.test(sig(i, -1)) && !/^(end\s+if|else|elsif)\b/i.test(sig(i, 1))) {
      pending = true;
      moved = true;
      continue;
    }
    out.push(lines[i]);
    depth += opens;
    depth -= closes;
    if (closes && depth <= 0) {
      depth = 0;
      if (pending) {
        out.push(`${/^\s*/.exec(lines[i])![0]}COMMIT;`);
        pending = false;
      }
    }
  }
  return moved && !pending ? out.join('\n') : null;
}

const CERT_NOTE = 'For PeopleSoft-delivered objects, check My Oracle Support for certification with PeopleTools 8.62 before using any 26ai feature.';

/**
 * Deterministic SQL / PL/SQL converter behind the mock LLM provider. It applies the
 * mechanical parts of section 9 (error capture, SERVEROUTPUT, a few safe rewrites) and
 * leaves judgement calls (set-based rewrites, bind conversion) as suggestions.
 */
export function mockConvertSql(source: string, opts: { embedded: boolean; note?: string | null }): SqlConversion {
  const changes: Change[] = [];
  const suggestions: Suggestion[] = [];
  const segs = splitScript(source);
  const out: string[] = [];
  let serverOutputSeen = false;
  let serverOutputAdded = false;
  for (const s of segs) {
    let text = s.text;
    if (s.kind === 'sqlplus' && /^\s*set\s+serverout(put)?\s+on\b/i.test(text)) serverOutputSeen = true;
    const executable = s.kind === 'sql' || s.kind === 'plsql' || (s.kind === 'sqlplus' && /^\s*(exec(ute)?\b|@)/i.test(text));
    if (executable && !serverOutputSeen && !serverOutputAdded) {
      out.push('SET SERVEROUTPUT ON SIZE UNLIMITED');
      serverOutputAdded = true;
      changes.push({ ruleId: 'sqlplus-serveroutput', lines: String(s.startLine), summary: 'SET SERVEROUTPUT ON added before the first statement', reason: 'The error-capture line written with DBMS_OUTPUT must reach the log. Works on 19c and 26ai.', risk: 'low' });
    }
    if (s.kind === 'plsql') {
      const r = instrumentUnit(text, s.plsqlType ?? 'anonymous');
      if (r.added.length) {
        text = r.text;
        for (const a of r.added) {
          changes.push({
            ruleId: a.kind === 'handler' ? 'plsql-error-capture' : 'plsql-error-capture-existing-handler',
            lines: String(s.startLine + a.line - 1),
            summary: a.kind === 'handler' ? 'WHEN OTHERS handler added: records SQLCODE, error stack and backtrace, then re-raises' : 'Existing WHEN OTHERS handler now records the error before doing what it did',
            reason: 'Failing unit, line and message are written as one ERROR|… line; RAISE keeps the original error and exit code.',
            risk: 'low',
          });
        }
      }
    }
    // a single SQL statement pasted without its ";" would never run in SQL*Plus: add the terminator
    if (s.kind === 'sql' && !s.terminated && text.trim() && (text.match(/^\s*(select|insert|update|delete|merge|create|alter|drop|truncate|grant|revoke|with)\b/gim) ?? []).length === 1) {
      text = text.replace(/\s*$/, ';');
      changes.push({ ruleId: 'sql-terminator', lines: String(s.endLine ?? s.startLine), summary: 'Missing ";" added at the end of the statement', reason: 'SQL*Plus runs a statement only when it is terminated; the source had no terminator.', risk: 'low' });
    }
    if (s.kind === 'sql' || s.kind === 'plsql') {
      const before = text;
      text = text.replace(/\bDBMS_XSLPROCESSOR\s*\.\s*CLOB2FILE\b/gi, 'DBMS_LOB.CLOB2FILE');
      if (text !== before) changes.push({ ruleId: 'desupported-clob2file', lines: String(s.startLine), summary: 'DBMS_XSLPROCESSOR.CLOB2FILE replaced by DBMS_LOB.CLOB2FILE', reason: 'Desupported in 21c; DBMS_LOB.CLOB2FILE exists on 19c and 26ai.', risk: 'medium' });
      if (s.kind === 'sql' && /^\s*select\b/i.test(text) && !/\bfrom\b/i.test(text)) {
        text = text.replace(/;\s*$/, ' FROM DUAL;');
        changes.push({ ruleId: 'dual-select-from-dual', lines: String(s.startLine), summary: 'FROM DUAL added', reason: 'SELECT without FROM is 26ai only.', risk: 'low' });
      }
    }
    out.push(text);
  }
  let sql = out.join('\n');

  // "Ask for a fix": the built-in converter can apply a few fixes by rule when the reviewer asks for them by code.
  const asked = new Set([...(opts.note ?? '').matchAll(/\bFix ([A-Z][A-Z_]+)\b/g)].map((m) => m[1]));
  if (asked.has('SQL_OUTPUT_NOT_SPOOLED') && !opts.embedded) {
    const r = addSpool(sql);
    if (r) {
      sql = r;
      changes.push({ ruleId: 'reviewer-note', lines: '1', summary: `SPOOL ${SPOOL_FILE} and SPOOL OFF added, as the reviewer asked`, reason: 'The SQL*Plus error report and the capture line now reach a log file. Check the file name and directory before use.', risk: 'low' });
    }
  }
  if (asked.has('SQL_COMMIT_IN_LOOP')) {
    const r = commitAfterLoop(sql);
    if (r) {
      sql = r;
      changes.push({ ruleId: 'reviewer-note', lines: '-', summary: 'COMMIT moved from inside the loop to after END LOOP, as the reviewer asked', reason: 'This changes the transaction boundary: the work is now committed once, and a failure rolls back the whole loop. Confirm the business process allows it.', risk: 'high' });
    }
  }

  if (/\bfrom\s+dual\b/i.test(sql)) suggestions.push({ title: 'After 19c is retired: SELECT without FROM DUAL', detail: `26ai accepts SELECT expressions without FROM DUAL. Not applied: it fails on 19c. ${CERT_NOTE}` });
  if (/\b(user|all)_(tables|objects|indexes|sequences)\b/i.test(sql) && /execute\s+immediate/i.test(sql)) {
    suggestions.push({ title: 'After 19c is retired: IF [NOT] EXISTS in DDL', detail: `The dictionary-lookup wrappers can become CREATE/DROP … IF [NOT] EXISTS on 26ai (also 19c from RU 19.28). Not applied: it fails on earlier 19c release updates. ${CERT_NOTE}` });
  }
  if (!/^\s*whenever\s+sqlerror/im.test(sql) && !opts.embedded) suggestions.push({ title: 'Consider WHENEVER SQLERROR EXIT', detail: 'The script continues past SQL errors, as the original did. Adding WHENEVER SQLERROR EXIT SQL.SQLCODE would make failures visible to the scheduler, but it changes behaviour, so it was not added.' });
  if (/\bloop\b[\s\S]*?\b(insert|update|delete)\b[\s\S]*?\bend\s+loop\b/i.test(sql)) suggestions.push({ title: 'Row-by-row DML', detail: 'A loop runs DML one row at a time. A set-based statement, or BULK COLLECT … LIMIT with FORALL, would be faster on both releases. The mock provider does not rewrite loops; the real provider does.' });
  if (/execute\s+immediate[\s\S]{0,300}?\|\|/i.test(sql)) suggestions.push({ title: 'Dynamic SQL built by concatenation', detail: 'Use bind variables (EXECUTE IMMEDIATE … USING) to avoid hard parses and SQL injection. The mock provider does not rewrite dynamic SQL; the real provider does.' });
  if (/select\s+count\s*\(\s*\*\s*\)\s+into/i.test(sql)) suggestions.push({ title: 'COUNT(*) used as an existence check', detail: 'Where the count is only compared with zero, an EXISTS subquery stops at the first row.' });
  if (opts.note) changes.push({ ruleId: 'reviewer-note', lines: '-', summary: `Reviewer note recorded: ${opts.note}`, reason: 'The built-in converter cannot act on free text; the note is kept for the human reviewer and the learning loop.', risk: 'low' });
  return { sql, changes, suggestions };
}
