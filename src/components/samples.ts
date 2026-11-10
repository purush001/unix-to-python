/** Built-in examples. Every name, host, address and password below is invented. */
export interface Sample {
  id: string;
  label: string;
  type: 'mixed' | 'plsql';
  source: string;
}

const KSH = `#!/bin/ksh
# nightly_dept_report.ksh - export the department head-count and mail it
# Author: Pat Example <pat.example@demo-corp.example>
OUT_DIR=/tmp/demo_reports
OUT_FILE=$OUT_DIR/dept_headcount.csv

sqlplus -s scott/tiger@//db-demo-01.demo-corp.example:1521/DEMOPDB <<EOF
WHENEVER SQLERROR EXIT 3
SET PAGESIZE 0 FEEDBACK OFF COLSEP ','
SPOOL $OUT_FILE
SELECT d.dname, COUNT(*)
  FROM dept d, emp e
 WHERE d.deptno = e.deptno
 GROUP BY d.dname;
SPOOL OFF
EXIT
EOF
if [ $? -ne 0 ]; then
  echo "head-count export failed"
  exit 3
fi

echo "Head-count report is ready" | mailx -s "Dept head-count" team@demo-corp.example
exit 0
`;

const PLSQL = `-- raise_low_salaries.sql - demo data only (SCOTT schema)
SET SERVEROUTPUT ON
DECLARE
  CURSOR c_emp IS
    SELECT empno, sal FROM emp WHERE deptno = 20;
  v_count NUMBER := 0;
BEGIN
  FOR r IN c_emp LOOP
    IF r.sal < 2000 THEN
      UPDATE emp SET sal = r.sal * 1.05 WHERE empno = r.empno;
      COMMIT;
      v_count := v_count + 1;
    END IF;
  END LOOP;
  DBMS_OUTPUT.PUT_LINE('Rows updated: ' || v_count);
EXCEPTION
  WHEN OTHERS THEN
    NULL;
END;
/
`;

export const SAMPLES: Sample[] = [
  { id: 'ksh', label: 'ksh + sqlplus heredoc', type: 'mixed', source: KSH },
  { id: 'plsql', label: 'PL/SQL cursor loop', type: 'plsql', source: PLSQL },
];
