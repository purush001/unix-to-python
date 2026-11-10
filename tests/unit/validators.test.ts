import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { scanDesupported, scanDualCompat } from '@/adapters/plsql/compat';
import { classify } from '@/agents/orchestrator';
import { compatCheck, errorCaptureCheck, objectCheck, parseCheck, variableCheck } from '@/adapters/plsql/validators';
import { validatePython } from '@/adapters/shell-python/validators';
import { Codes } from '@/pipeline/issue-codes';
import { mockConvertShell } from '@/providers/llm/mock-shell';
import { mockConvertSql } from '@/providers/llm/mock-sql';
import { sanitize } from '@/sanitizer';

const dual = (sql: string, plsql = false) => scanDualCompat(sql, { plsql });
const codes = (xs: { code: string }[]) => xs.map((x) => x.code);

describe('dual-compatibility scan', () => {
  const rejected: [string, string][] = [
    ['IF NOT EXISTS in DDL', 'CREATE TABLE IF NOT EXISTS t (id NUMBER);'],
    ['IF EXISTS in DDL', 'DROP TABLE IF EXISTS t;'],
    ['SELECT without FROM', 'SELECT SYSDATE;'],
    ['direct join in UPDATE', "UPDATE ps_job j SET j.grade = s.grade FROM ps_sal s WHERE s.emplid = j.emplid;"],
    ['direct join in DELETE', 'DELETE FROM ps_job j FROM ps_term t WHERE t.emplid = j.emplid;'],
    ['GROUP BY column alias', "SELECT TO_CHAR(effdt, 'YYYY') AS yr, COUNT(*) FROM ps_job GROUP BY yr;"],
    ['SQL BOOLEAN type', 'CREATE TABLE t (id NUMBER, active BOOLEAN);'],
    ['VECTOR type', 'CREATE TABLE t (id NUMBER, emb VECTOR(3));'],
    ['multi-row VALUES', "INSERT INTO t (a) VALUES (1), (2);"],
    ['new function', 'SELECT ANY_VALUE(deptid) FROM ps_job;'],
    ['SQL macro', 'CREATE FUNCTION f RETURN VARCHAR2 SQL_MACRO IS BEGIN RETURN q; END;'],
  ];
  for (const [name, sql] of rejected) {
    it(`rejects ${name}`, () => {
      const hits = dual(sql);
      expect(codes(hits)).toContain(Codes.SQL_NOT_DUAL_COMPATIBLE);
      expect(hits[0].line).toBe(1);
      expect(hits[0].message.length).toBeGreaterThan(20);
    });
  }

  it('finds 26ai-only syntax inside EXECUTE IMMEDIATE strings and reports the right line', () => {
    const hits = dual("BEGIN\n  NULL;\n  EXECUTE IMMEDIATE 'DROP TABLE IF EXISTS t';\nEND;", true);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(3);
  });

  it('accepts ordinary 19c SQL and PL/SQL', () => {
    const ok = [
      'SELECT SYSDATE FROM DUAL;',
      "SELECT deptid, COUNT(*) cnt FROM ps_job GROUP BY deptid;",
      "SELECT EXTRACT(YEAR FROM effdt) FROM ps_job;",
      "UPDATE ps_job SET grade = (SELECT MAX(grade) FROM ps_sal s WHERE s.emplid = ps_job.emplid) WHERE deptid = 'X';",
      'DELETE FROM ps_job WHERE emplid IN (SELECT emplid FROM ps_term);',
      'GRANT SELECT ON ps_job TO psreadonly;',
      "MERGE INTO ps_a a USING ps_b b ON (a.id = b.id) WHEN MATCHED THEN UPDATE SET a.x = b.x;",
      'SELECT LISTAGG(DISTINCT deptid, \',\') WITHIN GROUP (ORDER BY deptid) FROM ps_job;',
      'SELECT * FROM ps_job FOR UPDATE;',
    ];
    for (const s of ok) expect(dual(s), s).toEqual([]);
    expect(dual('DECLARE b BOOLEAN := TRUE; BEGIN IF b THEN NULL; END IF; END;', true)).toEqual([]);
  });

  it('keeps the existence-check wrappers of the DDL fixture and finds nothing to reject', () => {
    const src = sanitize(readFileSync('evals/fixtures/ddl-deploy-existence.sql', 'utf8'), 'sql', []).text;
    const out = mockConvertSql(src, { embedded: false }).sql;
    expect(compatCheck(out).filter((i) => i.code === Codes.SQL_NOT_DUAL_COMPATIBLE)).toEqual([]);
    expect(out).toMatch(/SELECT COUNT\(\*\) INTO v_count FROM USER_TABLES/);
    expect(out.match(/EXECUTE IMMEDIATE/g)).toHaveLength(3);
    expect(out).not.toMatch(/IF\s+(NOT\s+)?EXISTS/i);
  });
});

describe('desupported and deprecated features', () => {
  it('flags traditional auditing as desupported and DBMS_JOB as deprecated, with line numbers', () => {
    const hits = scanDesupported("BEGIN\n  DBMS_JOB.SUBMIT(j, 'x;');\nEND;\n/\nAUDIT SELECT ON sysadm.ps_job BY ACCESS;\nAUDIT POLICY my_pol;\n");
    expect(hits.find((h) => h.code === Codes.SQL_DEPRECATED_FEATURE)?.line).toBe(2);
    const audit = hits.filter((h) => h.code === Codes.SQL_DESUPPORTED_FEATURE);
    expect(audit).toHaveLength(1);
    expect(audit[0].line).toBe(5);
    expect(audit[0].message).toMatch(/unified audit/i);
  });
});

describe('SQL validators', () => {
  it('reports parse errors with the parser message and the line', () => {
    const issues = parseCheck("SET ECHO ON\nBEGIN\n  IF x THEN\n    NULL;\n  END LOOP;\nEND;\n/\nSELECT 'abc FROM DUAL;\n");
    expect(issues.every((i) => i.code === Codes.SQL_PARSE_ERROR)).toBe(true);
    const mismatch = issues.find((i) => /END LOOP does not match/.test(i.message))!;
    expect(mismatch.line).toBe(5);
    expect(mismatch.column).toBeGreaterThan(0);
    expect(issues.some((i) => /Unterminated string/.test(i.message) && i.line === 8)).toBe(true);
  });

  it('requires error capture in owned PL/SQL units and SERVEROUTPUT before the first statement', () => {
    const src = 'BEGIN\n  NULL;\nEND;\n/\n';
    expect(codes(errorCaptureCheck(src, src, false))).toEqual([Codes.SQL_NO_ERROR_CAPTURE, Codes.SQL_NO_ERROR_CAPTURE, Codes.SQL_OUTPUT_NOT_SPOOLED]);
    const fixed = mockConvertSql(src, { embedded: false }).sql;
    expect(codes(errorCaptureCheck(src, fixed, false))).toEqual([Codes.SQL_OUTPUT_NOT_SPOOLED]);
    expect(fixed).toMatch(/FORMAT_ERROR_BACKTRACE[\s\S]*RAISE;/);
  });

  it('keeps swallowed errors swallowed, adds the capture line and warns', () => {
    const src = 'SET SERVEROUTPUT ON\nSPOOL a.log\nBEGIN\n  DELETE FROM PS_T;\nEXCEPTION\n  WHEN OTHERS THEN NULL;\nEND;\n/\n';
    const out = mockConvertSql(src, { embedded: false }).sql;
    const issues = errorCaptureCheck(src, out, false);
    expect(codes(issues)).toEqual([Codes.SQL_ERROR_SWALLOWED]);
    expect(issues[0].line).toBe(6);
    expect(out).not.toMatch(/RAISE;/);
    expect(parseCheck(out)).toEqual([]);
  });

  it('does not allow WHENEVER SQLERROR EXIT to be added', () => {
    const src = 'SET SERVEROUTPUT ON\nSPOOL a.log\nSELECT 1 FROM DUAL;\n';
    expect(codes(errorCaptureCheck(src, 'WHENEVER SQLERROR EXIT 1\n' + src, false))).toContain(Codes.REVIEW_EXIT_CODE_CHANGED);
  });

  it('detects lost objects and lost substitution or bind variables', () => {
    const src = "UPDATE PS_JOB SET GRADE = :g WHERE DEPTID = '&dept';\nDELETE FROM PS_NW_TMP;\n";
    const out = "UPDATE PS_JOB SET GRADE = 'X' WHERE DEPTID = 'Y';\n";
    expect(objectCheck(src, out, []).map((i) => [i.code, i.sourceLine])).toEqual([[Codes.SQL_STATEMENT_LOST, 2]]);
    expect(codes(objectCheck(src, out, [{ ruleId: 'r', lines: '2', summary: 'Removed the PS_NW_TMP purge', reason: 'asked by reviewer', risk: 'high' }]))).toEqual([Codes.SQL_OBJECT_RENAMED]);
    expect(variableCheck(src, out).map((i) => i.message.split(' ')[0]).sort()).toEqual(['&dept', ':g']);
  });
});

describe('Python validators', () => {
  const shell = '#!/bin/sh\nscp /tmp/a.dat target_user@target_server:/in/\nif [ $? -ne 0 ]; then\n  exit 7\nfi\nexit 0\n';
  const good = () => mockConvertShell(shell, { generateConfig: true }).python;

  it('accepts the standard generated script', async () => {
    expect(await validatePython({ source: shell, draft: good() })).toEqual([]);
  });

  it('reports syntax errors with line and column', async () => {
    const broken = good().replace('def job(state: RunState, args: argparse.Namespace) -> int:', 'def job(state: RunState, args: argparse.Namespace -> int:');
    const issues = (await validatePython({ source: shell, draft: broken })).filter((i) => i.code === Codes.PY_SYNTAX_ERROR);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].line).toBe(broken.split('\n').findIndex((l) => l.startsWith('def job(')) + 1);
    expect(issues[0].column).toBeGreaterThan(0);
    expect(issues[0].message).toMatch(/syntax error/i);
  });

  it('rejects shell=True, os.system and eval with the line number', async () => {
    const bad = good().replace('    rc = 0\n', '    rc = 0\n    subprocess.run("ls -l", shell=True)\n    os.system("ls")\n    eval("1+1")\n');
    const issues = (await validatePython({ source: shell, draft: bad })).filter((i) => i.code === Codes.PY_SHELL_TRUE);
    expect(issues).toHaveLength(3);
    const first = bad.split('\n').findIndex((l) => l.includes('shell=True')) + 1;
    expect(issues.map((i) => i.line).sort((a, b) => a! - b!)).toEqual([first, first + 1, first + 2]);
  });

  it('requires logging, the failure email, error capture and config loading', async () => {
    const bare = '"""Doc."""\nimport sys\n\n\ndef main() -> int:\n    return 7\n\n\nif __name__ == "__main__":\n    sys.exit(main())\n';
    expect(codes(await validatePython({ source: shell, draft: bare })).sort()).toEqual([Codes.PY_NO_CONFIG, Codes.PY_NO_ERROR_CAPTURE, Codes.PY_NO_ERROR_EMAIL, Codes.PY_NO_LOGGING].sort());
  });

  it('detects a changed exit code and points at the source line', async () => {
    const changed = good().replace('return 7', 'return 1');
    const issues = (await validatePython({ source: shell, draft: changed })).filter((i) => i.code === Codes.PY_EXIT_CODE_CHANGED);
    expect(issues).toHaveLength(1);
    expect(issues[0].sourceLine).toBe(4);
  });

  it('rejects hosts written in the script and disabled host-key checking', async () => {
    const hard = good().replace('    rc = 0\n', '    rc = 0\n    host = "target_server"\n').replace('paramiko.RejectPolicy()', 'paramiko.AutoAddPolicy()');
    const issues = (await validatePython({ source: shell, draft: hard })).filter((i) => i.code === Codes.PY_HARDCODED_ENDPOINT);
    expect(issues).toHaveLength(2);
  });
});

describe('classification', () => {
  it('detects the script type and honours the selector', () => {
    expect(classify('SELECT 1 FROM DUAL;').type).toBe('sql');
    expect(classify('BEGIN\n NULL;\nEND;\n/').type).toBe('plsql');
    expect(classify('SET ECHO ON\nSPOOL a.log\nSELECT 1 FROM DUAL;\nSPOOL OFF').type).toBe('sqlplus');
    expect(classify('#!/bin/sh\necho hi\nexit 0').type).toBe('shell');
    expect(classify('#!/bin/ksh\nsqlplus -s / <<EOS\nSELECT 1 FROM DUAL;\nEOS').type).toBe('mixed');
    expect(classify('SELECT 1 FROM DUAL;', 'sqlplus').type).toBe('sqlplus');
    expect(classify('The quick brown fox.').type).toBe('unsupported');
    expect(classify('begin-program\n do main\nend-program').type).toBe('unsupported');
    expect(classify('       IDENTIFICATION DIVISION.\n       PROGRAM-ID. X.').type).toBe('unsupported');
  });
});
