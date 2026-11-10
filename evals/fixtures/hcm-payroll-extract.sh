#!/bin/ksh
#######################################################################
# hcm_pay_extract.sh - Bi-weekly payroll extract for the benefits vendor
# Author:      Margaret Okafor (margaret.okafor@northwind-hr.com)
# Modified by: Rajesh Venkataraman
# Change log:
#   2018-04-02  M. Okafor     Initial version
#   2021-09-17  rvenkat       Switched vendor transfer to sftp
# Schedule (cron): 30 2 * * 5 /home/mokafor/bin/hcm_pay_extract.sh PAY01
#######################################################################
export ORACLE_HOME=/u01/app/oracle/product/19.3.0.0/dbhome_1
export PATH=$ORACLE_HOME/bin:$PATH
PAYGROUP=$1
RUNDT=$(date +%Y%m%d)
OUTDIR=/psoft/hcm/outbound
OUTFILE=$OUTDIR/pay_extract_${RUNDT}.dat
DB_PASS=Summ3r#Payroll

if [ -z "$PAYGROUP" ]; then
  echo "usage: hcm_pay_extract.sh PAYGROUP"
  exit 2
fi

sqlplus -s sysadm/$DB_PASS@HCMPRD <<EOF
WHENEVER SQLERROR EXIT 3
SET PAGESIZE 0 FEEDBACK OFF HEADING OFF COLSEP '|'
SPOOL $OUTFILE
SELECT J.EMPLID, N.NAME, J.DEPTID, P.NET_PAY
  FROM PS_JOB J, PS_NAMES N, PS_PAY_CHECK P
 WHERE J.EMPLID = N.EMPLID
   AND J.EMPLID = P.EMPLID
   AND P.PAYGROUP = '$PAYGROUP'
   AND J.EMPLID <> '0045127';
SPOOL OFF
EXIT
EOF
if [ $? -ne 0 ]; then
  echo "extract failed" | mailx -s "HCM pay extract FAILED" dl-payroll@northwind-hr.com
  exit 3
fi

if [ ! -s $OUTFILE ]; then
  echo "extract file is empty"
  exit 4
fi

sftp nwpayxfer@sftp.paylocity-vendor.net <<EOF
cd /inbound/northwind
put $OUTFILE
bye
EOF
if [ $? -ne 0 ]; then
  exit 5
fi

gzip $OUTFILE
echo "Payroll extract complete for $PAYGROUP"
exit 0
