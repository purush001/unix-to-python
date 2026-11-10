import type { SkillRule } from '@/pipeline/types';

/**
 * Hand-written rules that ship with the code. Learned rules live in the database
 * (section 14.2). Rules guide generation only; they never change the sanitizer,
 * the validators or the guardrails.
 */
const r = (id: string, platform: SkillRule['platform'], trigger: string[], guidance: string, before: string, after: string): SkillRule => ({
  id, version: 1, platform, trigger, guidance, example: { before, after }, sourceRunId: null, evalWitness: null, status: 'base', indexed: false,
});

export const BASE_RULES: SkillRule[] = [
  r('base-plsql-error-capture', 'plsql', ['package', 'trigger', 'cursor-loop', 'dynamic-sql'],
    'Every owned PL/SQL unit records SQLCODE, FORMAT_ERROR_STACK and FORMAT_ERROR_BACKTRACE in its outermost WHEN OTHERS handler through DBMS_OUTPUT, then re-raises with RAISE.',
    'BEGIN\n  do_work;\nEND;\n/', 'BEGIN\n  do_work;\nEXCEPTION\n  WHEN OTHERS THEN\n    -- capture block (ERROR|unit=…|line=…|code=…|message=…)\n    RAISE;\nEND;\n/'),
  r('base-plsql-when-others-null', 'plsql', ['when-others-null'],
    'Where the source swallows errors with WHEN OTHERS THEN NULL, keep that behaviour, add the capture block first, and expect warning SQL_ERROR_SWALLOWED.',
    'EXCEPTION\n  WHEN OTHERS THEN NULL;', 'EXCEPTION\n  WHEN OTHERS THEN\n    -- capture block\n    NULL;'),
  r('base-plsql-existence-check', 'plsql', ['existence-check', 'ddl'],
    'Keep dictionary-lookup wrappers around CREATE/DROP (query USER_TABLES and friends, then EXECUTE IMMEDIATE). Never replace them with IF [NOT] EXISTS: that needs 26ai or 19c RU 19.28+. Suggest it under "After 19c is retired".',
    "SELECT COUNT(*) INTO n FROM user_tables WHERE table_name = 'T';\nIF n = 0 THEN EXECUTE IMMEDIATE 'CREATE TABLE t (id NUMBER)'; END IF;", 'unchanged'),
  r('base-plsql-cursor-loop', 'plsql', ['cursor-loop', 'commit-in-loop'],
    'Replace a row-by-row cursor loop with one set-based statement when the loop body is a single DML with no per-row branching. If a COMMIT sits inside the loop, keep the loop and the commit frequency and warn; use BULK COLLECT … LIMIT with FORALL only when the commit points stay the same.',
    'FOR r IN (SELECT emplid FROM ps_job WHERE …) LOOP\n  UPDATE ps_x SET flag = \'Y\' WHERE emplid = r.emplid;\nEND LOOP;', "UPDATE ps_x x SET flag = 'Y' WHERE EXISTS (SELECT 1 FROM ps_job j WHERE j.emplid = x.emplid AND …);"),
  r('base-plsql-dynamic-binds', 'plsql', ['dynamic-sql-concat', 'dynamic-sql'],
    'Dynamic SQL built by concatenating values becomes EXECUTE IMMEDIATE … USING with bind variables. Identifiers that must be dynamic are validated with DBMS_ASSERT.',
    "EXECUTE IMMEDIATE 'DELETE FROM ps_t WHERE emplid = ''' || p_emplid || '''';", "EXECUTE IMMEDIATE 'DELETE FROM ps_t WHERE emplid = :1' USING p_emplid;"),
  r('base-plsql-count-exists', 'plsql', ['count-existence'],
    'A COUNT(*) used only to test for existence becomes an EXISTS subquery (SELECT CASE WHEN EXISTS (…) THEN 1 ELSE 0 END FROM DUAL).',
    'SELECT COUNT(*) INTO n FROM ps_job WHERE emplid = p;\nIF n > 0 THEN', 'SELECT CASE WHEN EXISTS (SELECT 1 FROM ps_job WHERE emplid = p) THEN 1 ELSE 0 END INTO n FROM DUAL;\nIF n > 0 THEN'),
  r('base-plsql-audit', 'plsql', ['traditional-audit'],
    'Traditional AUDIT/NOAUDIT statements are desupported in 26ai. Create a unified audit policy and enable it with AUDIT POLICY; this works on 19c and 26ai.',
    'AUDIT SELECT ON sysadm.ps_job BY ACCESS;', 'CREATE AUDIT POLICY ps_job_select_pol ACTIONS SELECT ON sysadm.ps_job;\nAUDIT POLICY ps_job_select_pol;'),
  r('base-plsql-dbms-job', 'plsql', ['dbms-job'],
    'DBMS_JOB still works on both releases but is superseded. Convert DBMS_JOB.SUBMIT to DBMS_SCHEDULER.CREATE_JOB keeping the same action and interval, and note that the owner needs CREATE JOB.',
    "DBMS_JOB.SUBMIT(j, 'refresh_stats;', SYSDATE, 'SYSDATE+1');", "DBMS_SCHEDULER.CREATE_JOB(job_name => 'REFRESH_STATS_JOB', job_type => 'STORED_PROCEDURE', job_action => 'REFRESH_STATS', repeat_interval => 'FREQ=DAILY', enabled => TRUE);"),
  r('base-shell-sqlplus', 'shell-python', ['sqlplus-heredoc', 'sqlplus-spool', 'whenever-sqlerror'],
    'A sqlplus heredoc becomes run_sql() calls on one reused python-oracledb connection. Shell variables in SQL text become bind variables. SQL*Plus commits at session end, so commit at the end of each block. WHENEVER SQLERROR EXIT n becomes an exception that returns n.',
    'sqlplus -s user/${DB_PASSWORD}@DB <<EOF\nWHENEVER SQLERROR EXIT 3\nUPDATE ps_x SET a = 1 WHERE run = \'$RUN\';\nEOF', 'run_sql(state, "update", SQL_1, binds={"b_run": run}, exit_on_error=3)'),
  r('base-shell-exit-codes', 'shell-python', ['exit-code-check', 'psae', 'sqlldr', 'data-mover', 'sqr'],
    'Keep every explicit exit code. "cmd; if [ $? -ne 0 ]; then exit 4; fi" becomes rc = step(state, …); if rc != 0: return 4. External PeopleSoft and Oracle utilities stay external calls through run_command with an argument list.',
    'psae -CT ORACLE -CD $DB -R $RC -AI MYAE\nif [ $? -ne 0 ]; then exit 4; fi', 'rc = step(state, "psae", run_command, ["psae", "-CT", "ORACLE", …])\nif rc != 0:\n    return 4'),
  r('base-shell-transfer', 'shell-python', ['sftp', 'scp', 'ssh', 'ftp'],
    'scp and sftp use one reused paramiko session with host-key checking on. ftp keeps the protocol through ftplib and carries the SHELL_FTP_INSECURE marker. Hosts and users come from [source] / [target] in the config file.',
    'scp $FILE target_user@target_server:/inbound/', 'step(state, "upload", sftp_put, state, "target", file, "/inbound/")'),
  r('base-shell-mail', 'shell-python', ['mailx'],
    'mailx/mail/sendmail become send_mail() with smtplib and email.message; the body comes from the piped text or file.',
    'cat $LOG | mailx -s "Stats" ops@script.com', 'send_mail(state, ["ops@script.com"], "Stats", Path(log).read_text())'),
  r('base-shell-text-pipeline', 'shell-python', ['text-pipeline'],
    'grep/sed/awk/cut/sort/uniq/wc pipelines become Python that streams the file line by line with a regular expression compiled once.',
    "grep ERROR $LOG | wc -l", 'pattern = re.compile("ERROR")\ncount = sum(1 for line in open(log) if pattern.search(line))'),
];
