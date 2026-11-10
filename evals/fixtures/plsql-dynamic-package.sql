-- nw_purge_pkg.sql - purge helper with dynamic SQL
-- Written by: Margaret Okafor
CREATE OR REPLACE PACKAGE SYSADM.NW_PURGE_PKG AS
  PROCEDURE purge_by_emplid(p_table IN VARCHAR2, p_emplid IN VARCHAR2);
  FUNCTION row_count(p_table IN VARCHAR2, p_deptid IN VARCHAR2) RETURN NUMBER;
END NW_PURGE_PKG;
/

CREATE OR REPLACE PACKAGE BODY SYSADM.NW_PURGE_PKG AS

  PROCEDURE purge_by_emplid(p_table IN VARCHAR2, p_emplid IN VARCHAR2) IS
    v_sql VARCHAR2(4000);
  BEGIN
    v_sql := 'DELETE FROM ' || p_table || ' WHERE EMPLID = ''' || p_emplid || '''';
    EXECUTE IMMEDIATE v_sql;
    INSERT INTO PS_NW_PURGE_LOG (TABLE_NAME, EMPLID, PURGE_DTTM) VALUES (p_table, p_emplid, SYSDATE);
  END purge_by_emplid;

  FUNCTION row_count(p_table IN VARCHAR2, p_deptid IN VARCHAR2) RETURN NUMBER IS
    v_cnt NUMBER;
  BEGIN
    EXECUTE IMMEDIATE 'SELECT COUNT(*) FROM ' || p_table || ' WHERE DEPTID = ''' || p_deptid || '''' INTO v_cnt;
    RETURN v_cnt;
  EXCEPTION
    WHEN NO_DATA_FOUND THEN
      RETURN 0;
  END row_count;

END NW_PURGE_PKG;
/
SHOW ERRORS
