#!/bin/ksh
# dba_tbs_check.sh - Nightly tablespace usage report, mailed to the DBA list
# Author: Rajesh Venkataraman
# 0 6 * * * /home/rvenkat/dba/dba_tbs_check.sh
ORACLE_SID=HCMPRD
export ORACLE_SID
REPORT=/tmp/tbs_report_$$.txt
trap 'rm -f $REPORT' EXIT

sqlplus -s / as sysdba <<EOF
SET PAGESIZE 100 LINESIZE 132 FEEDBACK OFF
SPOOL $REPORT
SELECT TABLESPACE_NAME, ROUND(USED_PERCENT, 1) PCT_USED
  FROM DBA_TABLESPACE_USAGE_METRICS
 WHERE USED_PERCENT > 85
 ORDER BY USED_PERCENT DESC;
SPOOL OFF
EXIT
EOF

if [ -s $REPORT ]; then
  mailx -s "Tablespace usage above 85 percent on pshcmprd01.northwind-hr.com" dl-payroll@northwind-hr.com < $REPORT
fi
exit 0
