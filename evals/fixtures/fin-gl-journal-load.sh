#!/bin/bash
# fin_gl_jrnl_load.sh - Load GL journal interface file with SQL*Loader
# Owner: Rajesh Venkataraman
# 2020-02-11  rvenkat  Created
# crontab: 15 1 * * * /psoft/fin/scripts/fin_gl_jrnl_load.sh
. /psoft/fin/psconfig.sh
DATADIR=/psoft/fin/inbound
CTLFILE=/psoft/fin/ctl/gl_jrnl.ctl
INFILE=$DATADIR/gl_journal.dat
LOGDIR=/psoft/fin/logs
STAMP=`date +%Y%m%d%H%M`
LOADPW=Gl0bal$Load

if [ ! -f $INFILE ]; then
  echo "No journal file to load"
  exit 0
fi

sqlldr userid=sysadm/$LOADPW@FINPRD control=$CTLFILE data=$INFILE log=$LOGDIR/gl_jrnl_$STAMP.log bad=$LOGDIR/gl_jrnl_$STAMP.bad errors=0
RC=$?
if [ $RC -ne 0 ]; then
  echo "sqlldr failed with $RC"
  exit 8
fi

sqlplus -s sysadm/$LOADPW@FINPRD <<EOF
WHENEVER SQLERROR EXIT 9
UPDATE PS_JRNL_HEADER
   SET JRNL_HDR_STATUS = 'V'
 WHERE BUSINESS_UNIT = 'NW001'
   AND JRNL_HDR_STATUS = 'N'
   AND SOURCE = 'EXT';
COMMIT;
EXIT
EOF
if [ $? -ne 0 ]; then
  exit 9
fi

mv $INFILE $DATADIR/archive/gl_journal_$STAMP.dat
exit 0
