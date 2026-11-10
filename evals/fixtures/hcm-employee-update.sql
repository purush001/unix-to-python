-- hcm_upd_supervisor.sql
-- Author: Rajesh Venkataraman
-- 2019-11-05  rvenkat   Reassign direct reports after reorganisation
-- Contact: margaret.okafor@northwind-hr.com  phone (415) 555-0142
SET ECHO ON
SET TIMING ON
SPOOL hcm_upd_supervisor.log
WHENEVER SQLERROR EXIT SQL.SQLCODE ROLLBACK

DECLARE
  CURSOR c_emp IS
    SELECT J.EMPLID, J.EMPL_RCD, J.EFFDT
      FROM PS_JOB J
     WHERE J.SUPERVISOR_ID = '0045127'
       AND J.DEPTID = '&deptid'
       AND J.EFFDT = (SELECT MAX(J2.EFFDT) FROM PS_JOB J2
                       WHERE J2.EMPLID = J.EMPLID AND J2.EMPL_RCD = J.EMPL_RCD AND J2.EFFDT <= SYSDATE);
  v_count  NUMBER := 0;
  v_exists NUMBER;
BEGIN
  FOR r IN c_emp LOOP
    SELECT COUNT(*) INTO v_exists FROM PS_PERSONAL_DATA WHERE EMPLID = r.EMPLID;
    IF v_exists > 0 THEN
      UPDATE PS_JOB
         SET SUPERVISOR_ID = :new_supervisor,
             LASTUPDDTTM   = SYSDATE
       WHERE EMPLID = r.EMPLID
         AND EMPL_RCD = r.EMPL_RCD
         AND EFFDT = r.EFFDT;
      v_count := v_count + 1;
      COMMIT;
    END IF;
  END LOOP;
  DBMS_OUTPUT.PUT_LINE('Rows updated: ' || v_count);
END;
/

SELECT COUNT(*) FROM PS_JOB WHERE SUPERVISOR_ID = :new_supervisor;
SPOOL OFF
EXIT
