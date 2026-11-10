#!/bin/bash
# run_dms.sh - Run a Data Mover script and check its log
# Maintainer: Rajesh Venkataraman
set -e
DMS_SCRIPT=${1:-/psoft/hcm/dms/refresh_security.dms}
DM_LOG=/psoft/hcm/logs/datamover.log
ACCESS_PWD=Summ3r#Payroll

cd /psoft/hcm/dms
psdmtx -CT ORACLE -CD HCMPRD -CO PSBATCH1 -CP $ACCESS_PWD -FP $DMS_SCRIPT
if [ -f $DM_LOG ]; then
  cp $DM_LOG /psoft/hcm/logs/archive/
fi
echo "Data Mover finished"
