#!/bin/bash
# sync_term_report.sh - Build the termination report and push it to the reporting server
# Author: Margaret Okafor <margaret.okafor@northwind-hr.com>
# Reviewed by: Rajesh Venkataraman
# 2023-03-08  mokafor  Created
REPORT_DIR=/psoft/hcm/reports
REPORT=$REPORT_DIR/term_report.csv
REMOTE_HOST=10.44.12.7

if [ "$(hostname)" != "pshcmprd01" ]; then
  echo "must run on the production batch server"
  exit 7
fi

sqlplus -s sysadm/Summ3r#Payroll@//pshcmprd01.northwind-hr.com:1521/HCMPRD <<EOF
WHENEVER SQLERROR EXIT 11
SET PAGESIZE 0 FEEDBACK OFF COLSEP ','
SPOOL $REPORT
SELECT EMPLID, TERMINATION_DT, ACTION_REASON
  FROM PS_JOB
 WHERE ACTION = 'TER'
   AND TERMINATION_DT >= TRUNC(SYSDATE) - 7
   AND EMPLID NOT IN ('0045127', '0045128');
SPOOL OFF
BEGIN
  INSERT INTO PS_NW_RPT_LOG (RPT_NAME, RUN_DTTM) VALUES ('TERM', SYSDATE);
  COMMIT;
END;
/
EXIT
EOF
if [ $? -ne 0 ]; then
  exit 11
fi

scp $REPORT nwpayxfer@$REMOTE_HOST:/data/reports/incoming/
if [ $? -ne 0 ]; then
  exit 12
fi
ssh nwpayxfer@10.44.12.7 "chmod 640 /data/reports/incoming/term_report.csv"
echo "Report delivered" | mailx -s "Termination report delivered" dl-payroll@northwind-hr.com
exit 0
