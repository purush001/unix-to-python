#!/bin/ksh
# run_ae.sh - Launch an Application Engine program outside Process Scheduler
# Author: Margaret Okafor
# Usage: run_ae.sh AE_PROGRAM RUN_CONTROL
. /psoft/hcm/psconfig.sh
AE_NAME=$1
RUN_CNTL=$2
PS_OPR_PWD=Summ3r#Payroll

if [ -z "$AE_NAME" ]; then
  echo "AE program name is required"
  exit 2
fi

psae -CT ORACLE -CD HCMPRD -CO PSBATCH1 -CP $PS_OPR_PWD -R $RUN_CNTL -AI $AE_NAME -I 0 -DEBUG N
RC=$?
if [ $RC -eq 0 ]; then
  echo "$AE_NAME completed"
elif [ $RC -eq 1 ]; then
  echo "$AE_NAME finished with warnings"
  exit 1
else
  echo "$AE_NAME failed with return code $RC"
  exit 10
fi
exit 0
