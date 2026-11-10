import { Codes, issue, type Issue } from '@/pipeline/issue-codes';
import { code, stringValue, tokenize, type Tok } from './tokenizer';

/**
 * Dual-compatibility and desupport rules, matched on parsed tokens.
 *
 * Sources (Oracle documentation, read 2026-11):
 *  - 26ai Upgrade Guide ch. 10 "Oracle Database Changes, Desupports, and Deprecations"
 *  - 26ai New Features (Application Development / SQL), 21c SQL Reference "Changes in This Release"
 *  - 19c New Features release-update pages (19.7 SQL macros, 19.10 blockchain tables,
 *    19.11 immutable tables, 19.12 password rollover, 19.28 IF [NOT] EXISTS and annotations)
 * The baseline is ANY 19c release update, so features back-ported in a later RU are rejected too.
 */
export const COMPAT_RULES_VERSION = '2026.11-1';

const W = (t: Tok | undefined, ...ups: string[]) => !!t && t.type === 'word' && ups.includes(t.up);
const P = (t: Tok | undefined, text: string) => !!t && t.type === 'punct' && t.text === text;

/** Functions that do not exist on every 19c release update. */
const NEW_FUNCTIONS: Record<string, string> = {
  TO_BOOLEAN: '26ai only', BOOLEAN_AND_AGG: '26ai only', BOOLEAN_OR_AGG: '26ai only', UUID: '26ai only', IS_UUID: '26ai only',
  DATEADD: '26ai only', DATEDIFF: '26ai only', TIME_BUCKET: '26ai only', FUZZY_MATCH: '26ai only', PHONIC_ENCODE: '26ai only',
  GRAPH_TABLE: '26ai only', VECTOR_DISTANCE: '26ai only', TO_VECTOR: '26ai only', VECTOR_EMBEDDING: '26ai only', VECTOR_NORM: '26ai only',
  VECTOR_DIMENSION_COUNT: '26ai only', VECTOR_SERIALIZE: '26ai only', FROM_VECTOR: '26ai only', VECTOR_CHUNKS: '26ai only',
  JSON_SCALAR: '21c and later', BIT_AND_AGG: '21c and later', BIT_OR_AGG: '21c and later', BIT_XOR_AGG: '21c and later', CHECKSUM: '21c and later',
  KURTOSIS_POP: '21c and later', KURTOSIS_SAMP: '21c and later', SKEWNESS_POP: '21c and later', SKEWNESS_SAMP: '21c and later',
  ANY_VALUE: 'not available on every 19c release update', JSON_TRANSFORM: 'not available on every 19c release update',
};

const STATEMENT_STARTERS = new Set([';', '/']);
const PLSQL_STMT_PREV = new Set(['THEN', 'ELSE', 'BEGIN', 'LOOP', 'EXCEPTION']);

function depthAt(toks: Tok[]): number[] {
  const d: number[] = [];
  let cur = 0;
  for (const t of toks) {
    if (P(t, ')')) cur = Math.max(0, cur - 1);
    d.push(cur);
    if (P(t, '(')) cur++;
  }
  return d;
}

function statementStart(toks: Tok[], i: number): number {
  let k = i;
  while (k > 0 && !(toks[k - 1].type === 'punct' && STATEMENT_STARTERS.has(toks[k - 1].text))) k--;
  return k;
}
function startsStatement(toks: Tok[], i: number): boolean {
  const p = toks[i - 1];
  return !p || (p.type === 'punct' && (STATEMENT_STARTERS.has(p.text) || p.text === '>>')) || (p.type === 'word' && PLSQL_STMT_PREV.has(p.up));
}

function looksLikeSql(s: string): boolean {
  return /^\s*(select|insert|update|delete|merge|create|alter|drop|truncate|grant|revoke|begin|declare|with|audit|noaudit|comment|rename|call)\b/i.test(s);
}

export interface CompatOptions {
  /** True for PL/SQL units, where BOOLEAN is an ordinary PL/SQL type. */
  plsql: boolean;
  lineOffset?: number;
}

/** 26ai-only (or later-19c-only) syntax. Every hit is SQL_NOT_DUAL_COMPATIBLE. */
export function scanDualCompat(text: string, opts: CompatOptions): Issue[] {
  const toks = code(tokenize(text).tokens);
  const depth = depthAt(toks);
  const out: Issue[] = [];
  const off = opts.lineOffset ?? 0;
  const hit = (t: Tok, msg: string) => out.push(issue(Codes.SQL_NOT_DUAL_COMPATIBLE, msg, t.line + off, { column: t.col }));

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const next = toks[i + 1];
    const prev = toks[i - 1];

    if (t.type === 'string') {
      const v = stringValue(t);
      if (looksLikeSql(v)) out.push(...scanDualCompat(v, { plsql: /^\s*(begin|declare)\b/i.test(v), lineOffset: t.line - 1 + off }));
      continue;
    }
    if (t.type !== 'word') {
      continue;
    }
    const first = toks[statementStart(toks, i)];

    // IF [NOT] EXISTS in DDL (26ai; back-ported only in 19.28)
    if (t.up === 'IF' && (W(next, 'EXISTS') || (W(next, 'NOT') && W(toks[i + 2], 'EXISTS'))) && W(first, 'CREATE', 'DROP', 'ALTER')) {
      hit(t, 'IF [NOT] EXISTS in DDL needs 26ai or 19c RU 19.28+. Use an existence check in a PL/SQL block (query the data dictionary, then EXECUTE IMMEDIATE) or handle the "already exists"/"does not exist" error.');
    }

    // SELECT without FROM
    if (t.up === 'SELECT' && !W(first, 'GRANT', 'REVOKE', 'AUDIT', 'NOAUDIT')) {
      const d = depth[i];
      let found = false;
      for (let k = i + 1; k < toks.length; k++) {
        if (depth[k] < d || (depth[k] === d && P(toks[k], ';'))) break;
        if (depth[k] === d && W(toks[k], 'FROM')) {
          found = true;
          break;
        }
        if (depth[k] === d && W(toks[k], 'UNION', 'MINUS', 'INTERSECT', 'EXCEPT')) break;
      }
      if (!found) hit(t, 'SELECT without a FROM clause is 26ai only. Add FROM DUAL.');
    }

    // UPDATE … SET … FROM (direct join)
    if (t.up === 'UPDATE' && startsStatement(toks, i)) {
      const d = depth[i];
      let seenSet = false;
      for (let k = i + 1; k < toks.length; k++) {
        if (depth[k] < d || (depth[k] === d && (P(toks[k], ';') || W(toks[k], 'WHERE', 'RETURNING', 'RETURN', 'LOG')))) break;
        if (depth[k] === d && W(toks[k], 'SET')) seenSet = true;
        if (seenSet && depth[k] === d && W(toks[k], 'FROM')) {
          hit(toks[k], 'UPDATE with a FROM clause (direct join) is 26ai only. Use MERGE or a correlated subquery.');
          break;
        }
      }
    }
    // DELETE … FROM … FROM (direct join)
    if (t.up === 'DELETE' && startsStatement(toks, i)) {
      const d = depth[i];
      let froms = 0;
      for (let k = i + 1; k < toks.length; k++) {
        if (depth[k] < d || (depth[k] === d && (P(toks[k], ';') || W(toks[k], 'WHERE', 'RETURNING', 'RETURN', 'LOG')))) break;
        if (depth[k] === d && W(toks[k], 'FROM')) {
          froms++;
          if (froms > 1 || (k > i + 1 && froms === 1)) {
            hit(toks[k], 'DELETE with a second FROM clause (direct join) is 26ai only. Use a subquery with IN or EXISTS.');
            break;
          }
        }
      }
    }

    // GROUP BY alias / GROUP BY ALL
    if (t.up === 'GROUP' && W(next, 'BY')) {
      const d = depth[i];
      if (W(toks[i + 2], 'ALL')) hit(t, 'GROUP BY ALL is 26ai only. List the grouping expressions.');
      // find the matching SELECT list
      let s = i - 1;
      while (s >= 0 && !(depth[s] === d && W(toks[s], 'SELECT'))) {
        if (depth[s] < d) break;
        s--;
      }
      if (s >= 0 && W(toks[s], 'SELECT')) {
        const aliases = new Map<string, boolean>();
        let itemStart = s + 1;
        for (let k = s + 1; k <= i; k++) {
          const atEnd = depth[k] === d && (P(toks[k], ',') || W(toks[k], 'FROM'));
          if (!atEnd) continue;
          const item = toks.slice(itemStart, k);
          const last = item[item.length - 1];
          const before = item[item.length - 2];
          const hasAs = W(before, 'AS');
          const expr = item.slice(0, hasAs ? -2 : -1);
          const aliasShape = expr.length >= 1 && !!last && (last.type === 'word' || last.type === 'qident') && !!before && !P(before, '.') && !W(before, 'DISTINCT', 'UNIQUE', 'ALL') && (hasAs || before.type !== 'punct' || P(before, ')')) && !W(last, 'END', 'NULL');
          if (aliasShape) {
            const plainSame = expr.every((x) => x.type === 'word' || P(x, '.')) && expr[expr.length - 1].up === last.up;
            aliases.set(last.up, !plainSame);
          }
          itemStart = k + 1;
          if (W(toks[k], 'FROM')) break;
        }
        let gStart = i + 2;
        for (let k = i + 2; k <= toks.length; k++) {
          const tk = toks[k];
          const end = !tk || depth[k] < d || (depth[k] === d && (P(tk, ';') || P(tk, ',') || W(tk, 'HAVING', 'ORDER', 'UNION', 'MINUS', 'INTERSECT', 'FETCH', 'OFFSET', 'FOR', 'WINDOW', 'QUALIFY', 'LOOP')));
          if (!end) continue;
          const g = toks.slice(gStart, k);
          if (g.length === 1 && (g[0].type === 'word' || g[0].type === 'qident') && aliases.get(g[0].up)) {
            hit(g[0], `GROUP BY on the column alias ${g[0].text} is 26ai only. Repeat the expression in GROUP BY.`);
          }
          gStart = k + 1;
          if (!tk || !P(tk, ',') || depth[k] !== d) break;
        }
      }
    }

    // SQL BOOLEAN / VECTOR / JSON data types
    if (!opts.plsql && W(t, 'BOOLEAN', 'BOOL') && !P(prev, '.')) hit(t, 'The SQL BOOLEAN data type is 26ai only. Use NUMBER(1) or CHAR(1) with a check constraint.');
    if (W(t, 'VECTOR') && !P(prev, '.') && (P(next, '(') || !opts.plsql)) hit(t, 'The VECTOR data type is 26ai only.');
    if (!opts.plsql && W(t, 'JSON') && W(first, 'CREATE', 'ALTER') && prev && (prev.type === 'word' || prev.type === 'qident') && !W(prev, 'IS', 'FORMAT', 'AS') && (P(next, ',') || P(next, ')') || W(next, 'NOT', 'DEFAULT', 'CHECK'))) {
      hit(t, 'The JSON data type is 21c and later. Use CLOB or VARCHAR2 with an IS JSON check constraint.');
    }

    if (P(next, '(') && !P(prev, '.') && NEW_FUNCTIONS[t.up] && !(opts.plsql && W(prev, 'FUNCTION', 'PROCEDURE'))) {
      hit(t, `${t.up}() is ${NEW_FUNCTIONS[t.up]}; it is not safe on every 19c release update.`);
    }

    // Clauses and statements
    if (t.up === 'VALUES' && P(next, '(')) {
      let k = i + 2;
      let d2 = 1;
      while (k < toks.length && d2 > 0) {
        if (P(toks[k], '(')) d2++;
        if (P(toks[k], ')')) d2--;
        k++;
      }
      if (P(toks[k], ',') && P(toks[k + 1], '(')) hit(t, 'A table value constructor (VALUES with several rows) is 26ai only. Use INSERT ALL or one INSERT per row.');
    }
    if (t.up === 'QUALIFY' && !P(prev, '.') && !P(prev, ',') && !W(prev, 'SELECT', 'BY', 'AS') && next && !P(next, ',') && !P(next, ';') && !P(next, ')') && !P(next, '=') && !W(next, 'FROM')) hit(t, 'QUALIFY is 26ai only. Filter the analytic result in an outer query.');
    if (t.up === 'DOMAIN' && W(prev, 'CREATE', 'DROP', 'ALTER')) hit(t, 'SQL domains are 26ai only.');
    if (t.up === 'DUALITY' && W(next, 'VIEW')) hit(t, 'JSON-relational duality views are 26ai only.');
    if (t.up === 'PROPERTY' && W(next, 'GRAPH')) hit(t, 'Property graphs are 26ai only.');
    if (t.up === 'SCHEMA' && W(prev, 'ON') && W(first, 'GRANT', 'REVOKE')) hit(t, 'Schema-level privileges (GRANT … ON SCHEMA) are 26ai only. Grant on each object.');
    if (t.up === 'DB_DEVELOPER_ROLE') hit(t, 'DB_DEVELOPER_ROLE exists only in 26ai. Grant the individual privileges.');
    if (t.up === 'RESERVABLE') hit(t, 'RESERVABLE columns (lock-free reservations) are 26ai only.');
    if (t.up === 'ANNOTATIONS' && P(next, '(')) hit(t, 'Annotations need 26ai or 19c RU 19.28+. Use COMMENT ON instead.');
    if (t.up === 'EXCEPT' && W(next, 'SELECT', 'ALL') && !opts.plsql) hit(t, 'EXCEPT is 21c and later. Use MINUS.');
    if (W(t, 'MINUS', 'INTERSECT') && W(next, 'ALL')) hit(t, `${t.up} ALL is 21c and later.`);
    if (t.up === 'SQL_MACRO') hit(t, 'SQL macros were added in 19c RU 19.7 (table macros) and 21c (scalar macros); they are not safe on every 19c release update.');
    if (W(t, 'BLOCKCHAIN', 'IMMUTABLE') && W(next, 'TABLE')) hit(t, `${t.up} TABLE was added in a later 19c release update (19.10/19.11).`);
    if (t.up === 'PASSWORD_ROLLOVER_TIME') hit(t, 'Gradual password rollover was added in 19c RU 19.12.');
    if (t.up === 'RETURNING' && W(next, 'OLD', 'NEW')) hit(t, 'RETURNING OLD/NEW is 26ai only.');
    if (t.up === 'INSERT' && startsStatement(toks, i)) {
      for (let k = i + 1; k < toks.length && !P(toks[k], ';'); k++) {
        if (depth[k] !== depth[i]) continue;
        if (W(toks[k], 'VALUES', 'SELECT', 'WITH')) break;
        if (W(toks[k], 'SET')) {
          hit(toks[k], 'INSERT … SET is 26ai only. Use INSERT … VALUES.');
          break;
        }
      }
    }
    if (t.up === 'DEFAULT' && W(next, 'ON') && W(toks[i + 2], 'NULL') && W(toks[i + 3], 'FOR')) hit(t, 'DEFAULT ON NULL FOR INSERT AND UPDATE is 26ai only. DEFAULT ON NULL (insert only) works on both.');
  }
  return dedupe(out);
}

const DESUPPORTED_WORDS: Record<string, string> = {
  DBMS_OBFUSCATION_TOOLKIT: 'DBMS_OBFUSCATION_TOOLKIT was removed in 21c. Use DBMS_CRYPTO.',
  DBMS_CRYPTO_TOOLKIT: 'DBMS_CRYPTO_TOOLKIT was desupported in 21c. Use DBMS_CRYPTO.',
  DBMS_XMLSAVE: 'DBMS_XMLSAVE was desupported in 21c. Use SQL/XML (XMLTABLE with INSERT/MERGE).',
  DBMS_XMLQUERY: 'DBMS_XMLQUERY was desupported in 21c. Use SQL/XML functions (XMLELEMENT, XMLAGG, XMLFOREST).',
  XMLROOT: 'XMLRoot was desupported in 21c. Use XMLSERIALIZE with the VERSION clause.',
  DBMS_XDBT: 'DBMS_XDBT was desupported in 21c. Use CTX_DDL to manage Oracle Text indexes.',
  UTL_FILE_DIR: 'UTL_FILE_DIR was desupported in 18c. Use directory objects with UTL_FILE.',
  SEC_CASE_SENSITIVE_LOGON: 'SEC_CASE_SENSITIVE_LOGON was desupported in 21c; passwords are always case sensitive.',
  O7_DICTIONARY_ACCESSIBILITY: 'O7_DICTIONARY_ACCESSIBILITY was desupported in 19c.',
  REMOTE_OS_AUTHENT: 'REMOTE_OS_AUTHENT was desupported in 21c.',
  OPTIMIZER_SECURE_VIEW_MERGING: 'OPTIMIZER_SECURE_VIEW_MERGING is desupported in 26ai. Remove the setting.',
  ACTIVE_INSTANCE_COUNT: 'ACTIVE_INSTANCE_COUNT is desupported in 26ai. Remove the setting.',
  CLUSTER_DATABASE_INSTANCES: 'CLUSTER_DATABASE_INSTANCES was desupported in 21c. Remove the setting.',
  UNIFIED_AUDIT_SGA_QUEUE_SIZE: 'UNIFIED_AUDIT_SGA_QUEUE_SIZE was desupported in 21c. Remove the setting.',
  DISABLE_DIRECTORY_LINK_CHECK: 'DISABLE_DIRECTORY_LINK_CHECK was desupported in 21c.',
  FLUSH_UNIFIED_AUDIT_TRAIL: 'DBMS_AUDIT_MGMT.FLUSH_UNIFIED_AUDIT_TRAIL is desupported in 26ai; it is no longer needed. Remove the call.',
  VERIFY_FUNCTION: 'VERIFY_FUNCTION was desupported in 21c. Use ORA12C_VERIFY_FUNCTION.',
  VERIFY_FUNCTION_11G: 'VERIFY_FUNCTION_11G was desupported in 21c. Use ORA12C_VERIFY_FUNCTION.',
  CONTINUOUS_MINE: 'The LogMiner CONTINUOUS_MINE option was desupported in 19c.',
  PRODUCT_USER_PROFILE: 'The SQL*Plus PRODUCT_USER_PROFILE table was desupported in 19c.',
  DBMS_STREAMS_ADM: 'Oracle Streams was desupported in 19c. Use Oracle GoldenGate.',
  DBMS_STREAMS: 'Oracle Streams was desupported in 19c. Use Oracle GoldenGate.',
  DBMS_CAPTURE_ADM: 'Oracle Streams was desupported in 19c. Use Oracle GoldenGate.',
  DBMS_APPLY_ADM: 'Oracle Streams was desupported in 19c. Use Oracle GoldenGate.',
  DBMS_REPCAT: 'Advanced Replication was desupported in 12.2. Use Oracle GoldenGate.',
};
const DEPRECATED_WORDS: Record<string, string> = {
  DBMS_JOB: 'DBMS_JOB is still supported but superseded: jobs run as DBMS_SCHEDULER jobs and the owner needs the CREATE JOB privilege. Use DBMS_SCHEDULER for new work.',
  AUDIT_TRAIL: 'AUDIT_TRAIL is deprecated in 26ai (traditional auditing is desupported). Use unified audit policies.',
  AUDIT_SYS_OPERATIONS: 'AUDIT_SYS_OPERATIONS is deprecated in 26ai. Use unified audit policies.',
  AUDIT_FILE_DEST: 'AUDIT_FILE_DEST is deprecated in 26ai. Use unified audit policies.',
  AUDIT_SYSLOG_LEVEL: 'AUDIT_SYSLOG_LEVEL is deprecated in 26ai. Use unified audit policies.',
  DBMS_XMLSTORE: 'DBMS_XMLSTORE is deprecated in 26ai. Use SQL/XML.',
  DBMS_XMLGEN: 'DBMS_XMLGEN is deprecated in 26ai. Use SQL/XML functions.',
  SERVICE_NAMES: 'The SERVICE_NAMES parameter is deprecated since 19c. Manage services with SRVCTL or DBMS_SERVICE.',
  REMOTE_OS_ROLES: 'REMOTE_OS_ROLES is deprecated in 26ai.',
  PRE_PAGE_SGA: 'PRE_PAGE_SGA is deprecated in 26ai.',
  TRANSACTION_RECOVERY: 'TRANSACTION_RECOVERY is deprecated in 26ai.',
  ENCRYPT_NEW_TABLESPACES: 'ENCRYPT_NEW_TABLESPACES is deprecated in 26ai (replaced by TABLESPACE_ENCRYPTION, which does not exist in 19c). Review at upgrade time.',
  PARALLEL_ADAPTIVE_MULTI_USER: 'PARALLEL_ADAPTIVE_MULTI_USER is deprecated since 12.2.',
  DBMS_HANG_MANAGER: 'DBMS_HANG_MANAGER is deprecated in 26ai (replaced by DBMS_BLOCKER_RESOLVER, which does not exist in 19c).',
  BLACK_LIST: 'DBMS_RESULT_CACHE.BLACK_LIST* is deprecated in 26ai (BLOCK_LIST* replaces it).',
  BLACK_LIST_ADD: 'DBMS_RESULT_CACHE.BLACK_LIST* is deprecated in 26ai (BLOCK_LIST* replaces it).',
  HASH_MD4: 'MD4 in DBMS_CRYPTO is deprecated. Use SHA-2 (HASH_SH256).',
  HASH_MD5: 'MD5 in DBMS_CRYPTO is deprecated. Use SHA-2 (HASH_SH256).',
  HASH_SH1: 'SHA-1 in DBMS_CRYPTO is deprecated. Use SHA-2 (HASH_SH256).',
  ENCRYPT_DES: 'DES in DBMS_CRYPTO is deprecated. Use AES (ENCRYPT_AES256).',
  ENCRYPT_3DES: '3DES in DBMS_CRYPTO is deprecated. Use AES (ENCRYPT_AES256).',
  ENCRYPT_3DES_2KEY: '3DES in DBMS_CRYPTO is deprecated. Use AES (ENCRYPT_AES256).',
  ENCRYPT_RC4: 'RC4 in DBMS_CRYPTO is deprecated. Use AES (ENCRYPT_AES256).',
  DES_CBC_PKCS5: 'DES in DBMS_CRYPTO is deprecated. Use AES (AES_CBC_PKCS5).',
  DES3_CBC_PKCS5: '3DES in DBMS_CRYPTO is deprecated. Use AES (AES_CBC_PKCS5).',
};

/** Constructs that are desupported (error) or deprecated (warning) in 26ai. */
export function scanDesupported(text: string, lineOffset = 0): Issue[] {
  const toks = code(tokenize(text).tokens);
  const out: Issue[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const next = toks[i + 1];
    const prev = toks[i - 1];
    if (t.type === 'string') {
      const v = stringValue(t);
      if (/^external_name$/i.test(v.trim()) && toks.slice(Math.max(0, i - 4), i).some((x) => x.up === 'SYS_CONTEXT')) {
        out.push(issue(Codes.SQL_DESUPPORTED_FEATURE, "SYS_CONTEXT('USERENV','EXTERNAL_NAME') is desupported in 26ai. Use AUTHENTICATED_IDENTITY or ENTERPRISE_IDENTITY.", t.line + lineOffset, { column: t.col }));
      }
      if (/ora:contains/i.test(v)) out.push(issue(Codes.SQL_DESUPPORTED_FEATURE, 'The ora:contains XQuery function was desupported in 21c. Use XQuery Full Text.', t.line + lineOffset, { column: t.col }));
      if (looksLikeSql(v)) out.push(...scanDesupported(v, t.line - 1 + lineOffset));
      continue;
    }
    if (t.type !== 'word') continue;
    const first = toks[statementStart(toks, i)];
    if (W(t, 'AUDIT', 'NOAUDIT') && first === t && !W(next, 'POLICY', 'CONTEXT')) {
      out.push(issue(Codes.SQL_DESUPPORTED_FEATURE, `Traditional ${t.up} statements are desupported in 26ai (existing settings can only be deleted). Use a unified audit policy: CREATE AUDIT POLICY … then AUDIT POLICY … (works on 19c and 26ai).`, t.line + lineOffset, { column: t.col }));
    }
    if (DESUPPORTED_WORDS[t.up]) out.push(issue(Codes.SQL_DESUPPORTED_FEATURE, DESUPPORTED_WORDS[t.up], t.line + lineOffset, { column: t.col }));
    if (DEPRECATED_WORDS[t.up]) out.push(issue(Codes.SQL_DEPRECATED_FEATURE, DEPRECATED_WORDS[t.up], t.line + lineOffset, { column: t.col }));
    if (t.up === 'DBMS_XSLPROCESSOR' && P(next, '.') && W(toks[i + 2], 'CLOB2FILE', 'READ2CLOB')) {
      out.push(issue(Codes.SQL_DESUPPORTED_FEATURE, `DBMS_XSLPROCESSOR.${toks[i + 2].up} was desupported in 21c. Use DBMS_LOB.${toks[i + 2].up === 'CLOB2FILE' ? 'CLOB2FILE' : 'LOADCLOBFROMFILE'}.`, t.line + lineOffset, { column: t.col }));
    }
    if (t.up === 'OUTLINE' && W(prev, 'CREATE', 'REPLACE', 'ALTER')) out.push(issue(Codes.SQL_DEPRECATED_FEATURE, 'Stored outlines reach their terminal release in 26ai. Use SQL plan baselines.', t.line + lineOffset, { column: t.col }));
    if (t.up === 'LONG' && !P(prev, '.') && toks.slice(statementStart(toks, i), i).some((x) => W(x, 'TABLE')) && W(first, 'CREATE', 'ALTER')) {
      out.push(issue(Codes.SQL_DEPRECATED_FEATURE, 'LONG and LONG RAW columns are kept only for backward compatibility (not listed as desupported in the 26ai Upgrade Guide). Prefer CLOB/BLOB for new columns.', t.line + lineOffset, { column: t.col }));
    }
    if (t.up === 'TREAT' && P(next, '(')) {
      let k = i + 2;
      let d = 1;
      while (k < toks.length && d > 0) {
        if (P(toks[k], '(')) d++;
        if (P(toks[k], ')')) d--;
        k++;
      }
      if (W(toks[k - 2], 'JSON') && W(toks[k - 3], 'AS')) out.push(issue(Codes.SQL_DEPRECATED_FEATURE, 'TREAT(… AS JSON) is deprecated in 26ai (the JSON constructor that replaces it does not exist in 19c). Keep it for now and review after 19c is retired.', t.line + lineOffset, { column: t.col }));
    }
  }
  return dedupe(out);
}

function dedupe(issues: Issue[]): Issue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const k = `${i.code}|${i.line}|${i.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
